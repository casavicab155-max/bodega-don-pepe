// =============================================
// Bodega Don Pepe — Función Serverless
// Netlify Functions + Anthropic Claude + Supabase
// =============================================

const crypto            = require('crypto');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL      = process.env.SUPABASE_URL || 'https://eoyvzkargirskdttuxmn.supabase.co';
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const TOKEN_SECRET      = process.env.TOKEN_SECRET;
const ALLOWED_ORIGIN    = process.env.ALLOWED_ORIGIN || '';

// ─── Tokens de sesión (HMAC-SHA256, 24 h) ─────────────────────────────────────
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

function generarToken(payload) {
  const data = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_EXPIRY_MS })).toString('base64url');
  const sig  = crypto.createHmac('sha256', TOKEN_SECRET || '').update(data).digest('hex');
  return `${data}.${sig}`;
}

function verificarToken(token) {
  if (!TOKEN_SECRET) throw new Error('TOKEN_SECRET no configurado');
  if (!token) throw new Error('Sin sesión activa');
  const dot = token.lastIndexOf('.');
  if (dot < 1) throw new Error('Token inválido');
  const data     = token.slice(0, dot);
  const sig      = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('hex');
  const aBuf = Buffer.from(sig.padEnd(expected.length, '0').slice(0, expected.length));
  const bBuf = Buffer.from(expected);
  if (aBuf.length !== bBuf.length || !crypto.timingSafeEqual(aBuf, bBuf)) throw new Error('Token inválido');
  let payload;
  try { payload = JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { throw new Error('Token corrupto'); }
  if (payload.exp < Date.now()) throw new Error('Sesión expirada. Inicia sesión nuevamente.');
  return payload;
}

// ─── Rate limiting para login ─────────────────────────────────────────────────
const _loginAttempts = new Map();
function checkLoginRate(key) {
  const now = Date.now();
  const e   = _loginAttempts.get(key);
  if (!e || now - e.since > 15 * 60 * 1000) { _loginAttempts.set(key, { count: 1, since: now }); return null; }
  if (e.count >= 5) return `Demasiados intentos. Espera ${Math.ceil((15 * 60 * 1000 - (now - e.since)) / 60000)} minuto(s).`;
  e.count++;
  return null;
}
function clearLoginRate(key) { _loginAttempts.delete(key); }

// ─── Cabeceras CORS ───────────────────────────────────────────────────────────
function buildCors(reqOrigin) {
  const origin = (!ALLOWED_ORIGIN || reqOrigin === ALLOWED_ORIGIN) ? reqOrigin || 'null' : '';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
}

// ─── Helper: llamar a Supabase REST API ──────────────────────────────────────
async function sb(method, path, body = null) {
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : '',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error ${res.status}: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ─── Autenticación ───────────────────────────────────────────────────────────
async function handleAuth({ username, password }) {
  const key = (username || '').toLowerCase().trim();
  const rateErr = checkLoginRate(key);
  if (rateErr) return { ok: false, error: rateErr };

  const rows = await sb('GET', `usuarios?username=eq.${encodeURIComponent(username)}&activo=eq.true`);
  if (!rows || rows.length === 0) {
    console.warn('[SECURITY] AUTH_FAILURE user_not_found', key);
    return { ok: false, error: 'Usuario o contraseña incorrectos' };
  }
  const user = rows[0];
  if (user.password_hash !== password) {
    console.warn('[SECURITY] AUTH_FAILURE wrong_password', key);
    return { ok: false, error: 'Usuario o contraseña incorrectos' };
  }
  clearLoginRate(key);
  const tiendas = await sb('GET', `tiendas?id=eq.${user.tienda_id}`);
  const nombre_tienda = tiendas?.[0]?.nombre || '';
  const token = generarToken({ user_id: user.id, tienda_id: user.tienda_id, rol: user.rol, nombre: user.nombre });
  return {
    ok: true,
    token,
    user: { id: user.id, username: user.username, nombre: user.nombre, rol: user.rol, tienda_id: user.tienda_id, nombre_tienda },
  };
}

// ─── Catálogo global de códigos de barras ────────────────────────────────────
const CATEGORIA_MAP = {
  'beverages':'bebidas','drinks':'bebidas','waters':'bebidas','juices':'bebidas',
  'snacks':'snacks','chips':'snacks','dairies':'lacteos','dairy':'lacteos',
  'milk':'lacteos','breads':'panaderia','bakery':'panaderia',
  'cleaning':'limpieza','hygiene':'limpieza','groceries':'abarrotes','cereals':'abarrotes',
};
function mapCategoria(tags=[]) {
  for (const tag of tags) { const k=tag.replace('en:','').toLowerCase(); if(CATEGORIA_MAP[k]) return CATEGORIA_MAP[k]; }
  return 'general';
}
function mapUnidad(q='') {
  q=q.toLowerCase();
  if(q.includes('ml')||q.includes('lt')) return 'botella';
  if(q.includes('kg')||q.includes('gr')) return 'kg';
  if(q.includes('pack')) return 'paquete';
  return 'unidad';
}
async function buscarCatalogo({ codigo_barras }) {
  if (!codigo_barras) return { ok: false, error: 'Código requerido' };
  const local = await sb('GET', `catalogo_global?codigo_barras=eq.${encodeURIComponent(codigo_barras)}`);
  if (local && local.length > 0) return { ok: true, fuente: 'dona', producto: local[0] };
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${codigo_barras}?fields=product_name,brands,categories_tags,quantity`, {
      headers: { 'User-Agent': 'Dona-Bodega/1.0' },
    });
    if (r.ok) {
      const data = await r.json();
      if (data.status === 1 && data.product) {
        const p = data.product;
        const nombre = (p.product_name || '').trim();
        if (nombre) {
          const entrada = { codigo_barras, nombre, marca: (p.brands||'').split(',')[0].trim()||null, categoria: mapCategoria(p.categories_tags||[]), unidad: mapUnidad(p.quantity||'') };
          await sb('POST', 'catalogo_global', entrada).catch(()=>{});
          return { ok: true, fuente: 'openfoodfacts', producto: entrada };
        }
      }
    }
  } catch(_) {}
  return { ok: false, error: 'Producto no encontrado en el catálogo' };
}
async function guardarEnCatalogo({ codigo_barras, nombre, marca, categoria, unidad }) {
  if (!codigo_barras || !nombre) return { ok: false };
  await sb('POST', 'catalogo_global', { codigo_barras, nombre, marca: marca||null, categoria: categoria||'general', unidad: unidad||'unidad' })
    .catch(() => sb('PATCH', `catalogo_global?codigo_barras=eq.${encodeURIComponent(codigo_barras)}`, { nombre, marca, categoria, unidad }));
  return { ok: true };
}

// ─── Cambiar nombre de tienda ─────────────────────────────────────────────────
async function cambiarNombreTienda({ tienda_id, nuevo_nombre, solicitante_rol }) {
  if (solicitante_rol !== 'admin') return { ok: false, error: 'Solo el admin puede cambiar el nombre de la tienda' };
  if (!nuevo_nombre || nuevo_nombre.trim().length < 2) return { ok: false, error: 'El nombre debe tener al menos 2 caracteres' };
  await sb('PATCH', `tiendas?id=eq.${tienda_id}`, { nombre: nuevo_nombre.trim() });
  return { ok: true, nombre_tienda: nuevo_nombre.trim() };
}

// ─── Obtener productos ────────────────────────────────────────────────────────
async function getProductos() {
  return sb('GET', 'productos?activo=eq.true&order=nombre.asc');
}

// ─── Guardar producto (crear o actualizar) ────────────────────────────────────
async function saveProducto(producto) {
  if (producto.id) {
    const { id, created_at, ...data } = producto;
    await sb('PATCH', `productos?id=eq.${id}`, data);
    return { ok: true };
  } else {
    const { id, created_at, updated_at, ...data } = producto;
    const rows = await sb('POST', 'productos', data);
    return { ok: true, producto: rows[0] };
  }
}

// ─── Obtener ventas ───────────────────────────────────────────────────────────
async function getVentas(fechaInicio, fechaFin) {
  let query = 'ventas?order=created_at.desc';
  if (fechaInicio) query += `&created_at=gte.${fechaInicio}`;
  if (fechaFin) query += `&created_at=lte.${fechaFin}T23:59:59`;
  const ventas = await sb('GET', query);

  // Enriquecer con detalles
  const enriched = await Promise.all(ventas.map(async (v) => {
    const detalles = await sb('GET', `detalle_ventas?venta_id=eq.${v.id}`);
    const prods = await getProductos();
    const prodMap = Object.fromEntries(prods.map(p => [p.id, p.nombre]));
    return {
      ...v,
      items: detalles.map(d => ({
        ...d,
        nombre_producto: prodMap[d.producto_id] || 'Desconocido',
      })),
    };
  }));
  return enriched;
}

// ─── Registrar venta (el trigger DB descuenta el stock automáticamente) ───────
async function registrarVenta({ usuario_id, items, metodo_pago = 'efectivo', origen = 'manual' }) {
  if (!items || items.length === 0) throw new Error('La venta no tiene productos');

  const total = items.reduce((sum, i) => sum + i.precio_unitario * i.cantidad, 0);

  // Crear cabecera de venta
  const [venta] = await sb('POST', 'ventas', { usuario_id, total, metodo_pago, origen });

  // Crear detalles (el trigger de la DB descuenta el stock)
  for (const item of items) {
    await sb('POST', 'detalle_ventas', {
      venta_id: venta.id,
      producto_id: item.producto_id,
      cantidad: item.cantidad,
      precio_unitario: item.precio_unitario,
    });
  }

  return { ok: true, venta_id: venta.id, total };
}

// ─── Registrar entrada de mercadería (trigger DB suma al stock) ───────────────
async function registrarEntrada({ usuario_id, producto_id, cantidad, precio_costo, proveedor, origen = 'manual' }) {
  await sb('POST', 'entradas_mercaderia', {
    usuario_id, producto_id, cantidad, precio_costo, proveedor, origen,
  });
  return { ok: true };
}

// ─── Buscar producto por nombre (para comandos de voz) ───────────────────────
function buscarProductoPorNombre(nombre, productos) {
  const n = nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Coincidencia exacta primero
  let found = productos.find(p => {
    const pn = p.nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return pn === n;
  });
  // Luego parcial
  if (!found) {
    found = productos.find(p => {
      const pn = p.nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return pn.includes(n) || n.includes(pn.split(' ')[0]);
    });
  }
  return found;
}

// ─── IA Chat principal ────────────────────────────────────────────────────────
async function handleChat({ mensaje, usuario, historial = [] }) {
  const productos = await getProductos();

  const hoy = new Date().toLocaleDateString('es-PE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const inventarioTexto = productos.map(p => {
    const venc = p.fecha_vencimiento
      ? ` | Vence: ${new Date(p.fecha_vencimiento).toLocaleDateString('es-PE')}`
      : '';
    const alerta = p.stock <= p.stock_minimo ? ' ⚠️ STOCK BAJO' : '';
    return `- ${p.nombre} | Stock: ${p.stock} ${p.unidad}s | Precio: S/${p.precio_venta}${venc}${alerta}`;
  }).join('\n');

  const systemPrompt = `Eres el asistente de voz de la Bodega Don Pepe, una bodega peruana.
Hoy es ${hoy}. Atiendes a ${usuario?.nombre || 'el vendedor'} (${usuario?.rol || 'vendedor'}).

=== INVENTARIO ACTUAL ===
${inventarioTexto}

=== TU COMPORTAMIENTO ===
Hablas en español peruano, de forma natural y conversacional. Eres amigable y directo.
Cuando el usuario quiere REGISTRAR UNA VENTA (frases como "vendí", "véndeme", "el cliente llevó", "vendimos", "despachamos", etc.), 
debes responder EXCLUSIVAMENTE en este formato JSON sin ningún texto extra:

<VENTA>
{
  "mensaje": "Listo, registré la venta de [descripción]. Total: S/[monto].",
  "items": [
    {"nombre_buscado": "nombre del producto como lo dijo el cliente", "cantidad": número}
  ]
}
</VENTA>

Cuando el usuario quiere REGISTRAR UNA ENTRADA DE MERCADERÍA (frases como "entró mercadería", "recibí", "llegó pedido", "ingresé", etc.),
responde EXCLUSIVAMENTE en este formato JSON:

<ENTRADA>
{
  "mensaje": "Listo, registré la entrada de [descripción].",
  "items": [
    {"nombre_buscado": "nombre del producto", "cantidad": número, "precio_costo": número_o_null}
  ]
}
</ENTRADA>

Para cualquier otra consulta responde en texto normal. Sé conciso: máximo 3 oraciones.

IMPORTANTE — cuando el usuario pida una LISTA, CUADRO, TABLA o RESUMEN de productos/ventas/stock, responde con HTML así (sin markdown, sin bloques de código):
<table>
  <thead><tr><th>Columna1</th><th>Columna2</th><th>Columna3</th></tr></thead>
  <tbody>
    <tr><td>dato</td><td>dato</td><td>dato</td></tr>
  </tbody>
</table>
Para estado de stock usa: <span class="badge-stock ok">✓ OK</span> / <span class="badge-stock warn">⚠ Bajo</span> / <span class="badge-stock danger">🔴 Crítico</span>
Para totales en verde: <td style="color:#22c55e">S/XX.XX</td>
Encabeza la tabla con una línea de texto breve antes.
Nunca uses el formato <VENTA> o <ENTRADA> para preguntas generales.`;

  const messages = [
    ...historial.slice(-6), // últimos 6 mensajes para contexto
    { role: 'user', content: mensaje },
  ];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) throw new Error(`Claude API error: ${response.status}`);
  const data = await response.json();
  const texto = data.content[0].text.trim();

  // ── Parsear respuesta de VENTA ──────────────────────────────────────────────
  const ventaMatch = texto.match(/<VENTA>([\s\S]*?)<\/VENTA>/);
  if (ventaMatch) {
    try {
      const parsed = JSON.parse(ventaMatch[1].trim());
      const itemsResueltos = [];

      for (const item of parsed.items) {
        const prod = buscarProductoPorNombre(item.nombre_buscado, productos);
        if (!prod) {
          return {
            respuesta: `No encontré el producto "${item.nombre_buscado}" en el inventario. ¿Cómo se llama exactamente?`,
            accion: null,
          };
        }
        if (prod.stock < item.cantidad) {
          return {
            respuesta: `Stock insuficiente de ${prod.nombre}. Hay ${prod.stock} pero pediste ${item.cantidad}.`,
            accion: null,
          };
        }
        itemsResueltos.push({
          producto_id: prod.id,
          nombre_producto: prod.nombre,
          cantidad: item.cantidad,
          precio_unitario: prod.precio_venta,
        });
      }

      return {
        respuesta: parsed.mensaje,
        accion: { tipo: 'venta', items: itemsResueltos },
      };
    } catch (e) {
      console.error('Error parseando VENTA:', e, ventaMatch[1]);
    }
  }

  // ── Parsear respuesta de ENTRADA ────────────────────────────────────────────
  const entradaMatch = texto.match(/<ENTRADA>([\s\S]*?)<\/ENTRADA>/);
  if (entradaMatch) {
    try {
      const parsed = JSON.parse(entradaMatch[1].trim());
      const itemsResueltos = [];

      for (const item of parsed.items) {
        const prod = buscarProductoPorNombre(item.nombre_buscado, productos);
        if (!prod) {
          return {
            respuesta: `No encontré "${item.nombre_buscado}" en el inventario. ¿Cómo se llama exactamente?`,
            accion: null,
          };
        }
        itemsResueltos.push({
          producto_id: prod.id,
          nombre_producto: prod.nombre,
          cantidad: item.cantidad,
          precio_costo: item.precio_costo || null,
        });
      }

      return {
        respuesta: parsed.mensaje,
        accion: { tipo: 'entrada', items: itemsResueltos },
      };
    } catch (e) {
      console.error('Error parseando ENTRADA:', e, entradaMatch[1]);
    }
  }

  // ── Respuesta normal ────────────────────────────────────────────────────────
  return { respuesta: texto, accion: null };
}

// ─── Cambiar contraseña ───────────────────────────────────────────────────────
async function cambiarPassword({ usuario_id, password_actual, nueva_password, target_id, solicitante_rol, tienda_id }) {
  if (!nueva_password || nueva_password.length < 6) return { ok: false, error: 'La nueva contraseña debe tener al menos 6 caracteres' };
  if (target_id && target_id !== usuario_id) {
    if (solicitante_rol !== 'admin') return { ok: false, error: 'Sin permisos' };
    const check = await sb('GET', `usuarios?id=eq.${target_id}&tienda_id=eq.${tienda_id}`);
    if (!check || check.length === 0) return { ok: false, error: 'Usuario no encontrado en tu tienda' };
    await sb('PATCH', `usuarios?id=eq.${target_id}`, { password_hash: nueva_password });
    return { ok: true };
  }
  const rows = await sb('GET', `usuarios?id=eq.${usuario_id}&activo=eq.true`);
  if (!rows || rows.length === 0) return { ok: false, error: 'Usuario no encontrado' };
  const user = rows[0];
  if (user.password_hash !== password_actual) return { ok: false, error: 'La contraseña actual es incorrecta' };
  await sb('PATCH', `usuarios?id=eq.${usuario_id}`, { password_hash: nueva_password });
  return { ok: true };
}

// ─── Handler principal ────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const reqOrigin = event.headers.origin || event.headers.Origin || '';
  const CORS = buildCors(reqOrigin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
    const { action } = body;

    // ─── Verificación de sesión ────────────────────────────────────────────────
    const PUBLIC_ACTIONS = new Set(['auth', 'ping']);
    if (!PUBLIC_ACTIONS.has(action)) {
      if (!TOKEN_SECRET) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Configuración de seguridad incompleta' }) };
      try {
        const session = verificarToken(body.token);
        body.tienda_id       = session.tienda_id;
        body.usuario_id      = session.user_id;
        body.solicitante_rol = session.rol;
        body.usuario         = { id: session.user_id, tienda_id: session.tienda_id, rol: session.rol, nombre: session.nombre };
      } catch (e) {
        console.warn('[SECURITY] INVALID_TOKEN', action, e.message);
        return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: e.message, sesion_invalida: true }) };
      }
    }

    let result;
    switch (action) {
      case 'auth':
        result = await handleAuth(body);
        break;

      case 'getProductos':
        result = await getProductos();
        break;

      case 'saveProducto':
        result = await saveProducto(body.producto);
        break;

      case 'getVentas':
        result = await getVentas(body.fechaInicio, body.fechaFin);
        break;

      case 'registrarVenta':
        result = await registrarVenta(body);
        break;

      case 'registrarEntrada':
        result = await registrarEntrada(body);
        break;

      case 'cambiarPassword':
        result = await cambiarPassword(body);
        break;

      case 'cambiarNombreTienda':
        result = await cambiarNombreTienda(body);
        break;

      case 'buscarCatalogo':
        result = await buscarCatalogo(body);
        break;

      case 'guardarEnCatalogo':
        result = await guardarEnCatalogo(body);
        break;

      case 'chat': {
        const { respuesta, accion } = await handleChat(body);

        // Ejecutar acción automáticamente si la IA la detectó
        if (accion?.tipo === 'venta') {
          try {
            await registrarVenta({
              usuario_id: body.usuario?.id || null,
              items: accion.items,
              origen: 'voz',
            });
          } catch (e) {
            return {
              statusCode: 200,
              headers: CORS,
              body: JSON.stringify({ respuesta: `Error al registrar venta: ${e.message}` }),
            };
          }
        }

        if (accion?.tipo === 'entrada') {
          try {
            for (const item of accion.items) {
              await registrarEntrada({
                usuario_id: body.usuario?.id || null,
                producto_id: item.producto_id,
                cantidad: item.cantidad,
                precio_costo: item.precio_costo,
                origen: 'voz',
              });
            }
          } catch (e) {
            return {
              statusCode: 200,
              headers: CORS,
              body: JSON.stringify({ respuesta: `Error al registrar entrada: ${e.message}` }),
            };
          }
        }

        result = { respuesta, accion };
        break;
      }

      default:
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Acción no reconocida' }) };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('[BodegaAPI ERROR]', { action: body?.action, error: err.message });
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Error interno del servidor' }),
    };
  }
};
