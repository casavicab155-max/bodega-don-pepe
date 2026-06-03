// =============================================
// Bodega Don Pepe — Función Serverless
// Netlify Functions + Anthropic Claude + Supabase
// =============================================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://eoyvzkargirskdttuxmn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVveXZ6a2FyZ2lyc2tkdHR1eG1uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0OTQyNzIsImV4cCI6MjA5NTA3MDI3Mn0.k3Znq41STrhcpVW-9ETvtojN6qZqEsovV-VC_Nxox6I';

// ─── Cabeceras CORS ───────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

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
  const rows = await sb('GET', `usuarios?username=eq.${encodeURIComponent(username)}&activo=eq.true`);
  if (!rows || rows.length === 0) return { ok: false, error: 'Usuario no encontrado' };
  const user = rows[0];
  // En producción usar bcrypt; por ahora comparación directa
  if (user.password_hash !== password) return { ok: false, error: 'Contraseña incorrecta' };
  return {
    ok: true,
    user: { id: user.id, username: user.username, nombre: user.nombre, rol: user.rol },
  };
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
async function cambiarPassword({ usuario_id, password_actual, nueva_password, target_id, solicitante_rol }) {
  if (!nueva_password || nueva_password.length < 6) return { ok: false, error: 'La nueva contraseña debe tener al menos 6 caracteres' };
  if (target_id && target_id !== usuario_id) {
    if (solicitante_rol !== 'admin') return { ok: false, error: 'Sin permisos' };
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
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { action } = body;
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
    console.error('[BodegaAPI]', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
