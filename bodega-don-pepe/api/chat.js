// =============================================
// Bodega Don Pepe — Función Serverless
// Netlify Functions + Anthropic Claude + Supabase
// =============================================

const bcrypt = require('bcryptjs');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://eoyvzkargirskdttuxmn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVveXZ6a2FyZ2lyc2tkdHR1eG1uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0OTQyNzIsImV4cCI6MjA5NTA3MDI3Mn0.k3Znq41STrhcpVW-9ETvtojN6qZqEsovV-VC_Nxox6I';

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
  // Comparar con bcrypt si el hash empieza con $2, sino comparación directa (legacy)
  let passwordOk = false;
  if (user.password_hash && user.password_hash.startsWith('$2')) {
    passwordOk = await bcrypt.compare(password, user.password_hash);
  } else {
    passwordOk = user.password_hash === password;
    // Si coincide, migrar a bcrypt automáticamente
    if (passwordOk) {
      const hashed = await bcrypt.hash(password, 10);
      await sb('PATCH', `usuarios?id=eq.${user.id}`, { password_hash: hashed });
    }
  }
  if (!passwordOk) return { ok: false, error: 'Contraseña incorrecta' };
  return {
    ok: true,
    user: { id: user.id, username: user.username, nombre: user.nombre, rol: user.rol, tienda_id: user.tienda_id },
  };
}

// ─── Registrar nueva tienda ───────────────────────────────────────────────────
async function registrarTienda({ nombre_tienda, nombre_admin, password }) {
  if (!nombre_tienda || !nombre_admin || !password) {
    return { ok: false, error: 'Faltan datos obligatorios' };
  }
  // Verificar que el username no exista
  const existente = await sb('GET', `usuarios?username=eq.${encodeURIComponent(nombre_admin)}`);
  if (existente && existente.length > 0) {
    return { ok: false, error: 'Ese nombre de usuario ya existe' };
  }
  // Crear tienda
  const [tienda] = await sb('POST', 'tiendas', { nombre: nombre_tienda, propietario: nombre_admin, plan: 'basico' });
  // Crear usuario admin de esa tienda
  const hashedPassword = await bcrypt.hash(password, 10);
  const [usuario] = await sb('POST', 'usuarios', {
    username: nombre_admin,
    password_hash: hashedPassword,
    nombre: nombre_admin,
    rol: 'admin',
    tienda_id: tienda.id,
  });
  return {
    ok: true,
    user: { id: usuario.id, username: usuario.username, nombre: usuario.nombre, rol: usuario.rol, tienda_id: tienda.id },
    tienda: { id: tienda.id, nombre: tienda.nombre },
  };
}

// ─── Gestión de vendedores ────────────────────────────────────────────────────
async function getVendedores(tienda_id) {
  return sb('GET', `usuarios?tienda_id=eq.${tienda_id}&rol=eq.vendedor&activo=eq.true&order=nombre.asc`);
}

async function crearVendedor({ tienda_id, nombre, username, password }) {
  const existente = await sb('GET', `usuarios?username=eq.${encodeURIComponent(username)}`);
  if (existente && existente.length > 0) return { ok: false, error: 'Ese usuario ya existe' };
  const hashedVend = await bcrypt.hash(password, 10);
  await sb('POST', 'usuarios', { username, password_hash: hashedVend, nombre, rol: 'vendedor', tienda_id, activo: true });
  return { ok: true };
}

async function desactivarVendedor(id) {
  await sb('PATCH', `usuarios?id=eq.${id}`, { activo: false });
  return { ok: true };
}

// ─── Obtener productos ────────────────────────────────────────────────────────
async function getProductos(tienda_id) {
  if (tienda_id) {
    return sb('GET', `productos?activo=eq.true&tienda_id=eq.${tienda_id}&order=nombre.asc`);
  }
  return sb('GET', 'productos?activo=eq.true&order=nombre.asc');
}

// ─── Guardar producto (crear o actualizar) ────────────────────────────────────
async function saveProducto(producto, tienda_id) {
  if (producto.id) {
    const { id, created_at, ...data } = producto;
    await sb('PATCH', `productos?id=eq.${id}`, data);
    return { ok: true };
  } else {
    const { id, created_at, updated_at, ...data } = producto;
    if (tienda_id) data.tienda_id = tienda_id;
    const rows = await sb('POST', 'productos', data);
    return { ok: true, producto: rows[0] };
  }
}

// ─── Obtener ventas ───────────────────────────────────────────────────────────
async function getVentas(fechaInicio, fechaFin, tienda_id) {
  let query = 'ventas?order=created_at.desc';
  if (tienda_id) query += `&tienda_id=eq.${tienda_id}`;
  if (fechaInicio) query += `&created_at=gte.${fechaInicio}`;
  if (fechaFin) query += `&created_at=lte.${fechaFin}T23:59:59`;
  const ventas = await sb('GET', query);

  const enriched = await Promise.all(ventas.map(async (v) => {
    const detalles = await sb('GET', `detalle_ventas?venta_id=eq.${v.id}`);
    const prods = await getProductos(tienda_id);
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
async function registrarVenta({ usuario_id, tienda_id, items, metodo_pago = 'efectivo', origen = 'manual' }) {
  if (!items || items.length === 0) throw new Error('La venta no tiene productos');

  const total = items.reduce((sum, i) => sum + i.precio_unitario * i.cantidad, 0);

  const [venta] = await sb('POST', 'ventas', { usuario_id, tienda_id, total, metodo_pago, origen });

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
async function registrarEntrada({ usuario_id, tienda_id, producto_id, cantidad, precio_costo, proveedor, origen = 'manual' }) {
  await sb('POST', 'entradas_mercaderia', {
    usuario_id, tienda_id, producto_id, cantidad, precio_costo, proveedor, origen,
  });
  return { ok: true };
}

// ─── Ajustar stock manualmente ───────────────────────────────────────────────
async function ajustarStock({ producto_id, nuevo_stock, desactivar = false }) {
  if (desactivar) {
    await sb('PATCH', `productos?id=eq.${producto_id}`, { activo: false });
  } else {
    await sb('PATCH', `productos?id=eq.${producto_id}`, { stock: nuevo_stock });
  }
  return { ok: true };
}

// ─── Editar cualquier campo de un producto ───────────────────────────────────
async function editarProducto({ producto_id, campos }) {
  // campos es un objeto con solo los campos a actualizar
  const permitidos = ['nombre', 'categoria', 'precio_venta', 'precio_costo', 'stock', 'stock_minimo', 'unidad', 'fecha_vencimiento'];
  const data = {};
  for (const k of permitidos) {
    if (campos[k] !== undefined && campos[k] !== null) data[k] = campos[k];
  }
  if (Object.keys(data).length === 0) return { ok: false, error: 'No hay campos para actualizar' };
  await sb('PATCH', `productos?id=eq.${producto_id}`, data);
  return { ok: true };
}

// ─── Anular última venta de la tienda ────────────────────────────────────────
async function anularUltimaVenta({ tienda_id }) {
  const ventas = await sb('GET', `ventas?tienda_id=eq.${tienda_id}&order=created_at.desc&limit=1`);
  if (!ventas || ventas.length === 0) return { ok: false, error: 'No hay ventas para anular' };
  const venta = ventas[0];
  // Devolver stock de cada item
  const detalles = await sb('GET', `detalle_ventas?venta_id=eq.${venta.id}`);
  for (const d of detalles) {
    const [prod] = await sb('GET', `productos?id=eq.${d.producto_id}`);
    if (prod) {
      await sb('PATCH', `productos?id=eq.${d.producto_id}`, { stock: prod.stock + d.cantidad });
    }
  }
  // Eliminar detalles y venta
  await sb('DELETE', `detalle_ventas?venta_id=eq.${venta.id}`);
  await sb('DELETE', `ventas?id=eq.${venta.id}`);
  return { ok: true, total: venta.total };
}

// ─── Resumen de ventas (hoy, semana) ─────────────────────────────────────────
async function resumenVentas({ tienda_id, periodo = 'hoy' }) {
  const ahora = new Date();
  let desde;
  if (periodo === 'hoy') {
    desde = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()).toISOString();
  } else if (periodo === 'semana') {
    desde = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  } else if (periodo === 'mes') {
    desde = new Date(ahora.getFullYear(), ahora.getMonth(), 1).toISOString();
  }
  const ventas = await sb('GET', `ventas?tienda_id=eq.${tienda_id}&created_at=gte.${desde}`);
  const total = ventas.reduce((s, v) => s + parseFloat(v.total), 0);
  return { ok: true, cantidad: ventas.length, total: total.toFixed(2) };
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
  const tienda_id = usuario?.tienda_id;
  const productos = await getProductos(tienda_id);

  const hoy = new Date().toLocaleDateString('es-PE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const inventarioTexto = productos.map(p => {
    const venc = p.fecha_vencimiento
      ? ` | Vence: ${new Date(p.fecha_vencimiento).toLocaleDateString('es-PE')}`
      : '';
    const alerta = p.stock <= p.stock_minimo ? ' ⚠️ STOCK BAJO' : '';
    const costo = p.precio_costo ? ` | Costo: S/${p.precio_costo}` : '';
    return `- ${p.nombre} | Stock: ${p.stock} ${p.unidad}s | Precio: S/${p.precio_venta}${costo}${venc}${alerta}`;
  }).join('\n');

  // Calcular valor total del inventario y ganancia potencial
  const valorInventario = productos.reduce((s, p) => s + (p.precio_venta * p.stock), 0).toFixed(2);
  const costoInventario = productos.reduce((s, p) => s + ((p.precio_costo || 0) * p.stock), 0).toFixed(2);
  const gananciaPotencial = (valorInventario - costoInventario).toFixed(2);

  // Resumen de ventas de hoy
  let ventasHoyTexto = '';
  try {
    const hoyIni = new Date(); hoyIni.setHours(0,0,0,0);
    const ventasHoy = await sb('GET', `ventas?tienda_id=eq.${tienda_id}&created_at=gte.${hoyIni.toISOString()}`);
    const totalHoy = ventasHoy.reduce((s, v) => s + parseFloat(v.total), 0).toFixed(2);
    ventasHoyTexto = `Ventas de hoy: ${ventasHoy.length} ventas, total S/${totalHoy}`;
  } catch { ventasHoyTexto = ''; }

  const systemPrompt = `Eres el asistente de voz de la Bodega Don Pepe, una bodega peruana.
Hoy es ${hoy}. Atiendes a ${usuario?.nombre || 'el vendedor'} (${usuario?.rol || 'vendedor'}).

=== INVENTARIO ACTUAL ===
${inventarioTexto}

=== DATOS DE LA TIENDA ===
Valor del inventario (a precio venta): S/${valorInventario}
Costo del inventario: S/${costoInventario}
Ganancia potencial si vendes todo: S/${gananciaPotencial}
${ventasHoyTexto}

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

Cuando el usuario quiere REGISTRAR UNA ENTRADA DE MERCADERÍA (frases como "entró mercadería", "recibí", "llegó pedido", "ingresé", "llegaron", etc.),
responde EXCLUSIVAMENTE en este formato JSON:

<ENTRADA>
{
  "mensaje": "Listo, registré la entrada de [descripción].",
  "items": [
    {
      "nombre_buscado": "nombre del producto",
      "cantidad": número,
      "precio_costo": número_o_null,
      "precio_venta": número_o_null,
      "categoria": "categoría_o_null",
      "unidad": "unidad_o_null"
    }
  ]
}
</ENTRADA>

REGLA IMPORTANTE para entradas de mercadería:
- Si el producto YA EXISTE en el inventario: solo necesitas nombre_buscado y cantidad (precio_venta y categoria pueden ser null)
- Si el producto NO EXISTE en el inventario: necesitas precio_venta obligatoriamente. Si el usuario no lo mencionó, pregúntale ANTES de responder con <ENTRADA>: "Ese producto no lo tengo registrado. ¿A cuánto lo vas a vender?"
- precio_costo es opcional siempre
- unidad: si no se menciona, usa "unidad" por defecto
- categoria: si no se menciona, usa "general" por defecto
- Cuando el producto es nuevo y tienes precio_venta, incluye todos los datos para crearlo

Cuando el usuario quiere EDITAR, AJUSTAR STOCK o ELIMINAR uno o varios productos existentes, responde EXCLUSIVAMENTE así:
<EDITAR>
{
  "mensaje": "Listo, [descripción del cambio].",
  "productos": [
    {
      "nombre_buscado": "nombre del producto",
      "eliminar": true_o_false,
      "campos": {
        "stock": número_o_omitir,
        "precio_venta": número_o_omitir,
        "precio_costo": número_o_omitir,
        "nombre": "texto_o_omitir",
        "categoria": "texto_o_omitir",
        "unidad": "texto_o_omitir",
        "stock_minimo": número_o_omitir,
        "fecha_vencimiento": "YYYY-MM-DD_o_omitir"
      }
    }
  ]
}
</EDITAR>

REGLAS para EDITAR:
- Puedes editar VARIOS productos a la vez (por eso "productos" es una lista). Ej: "se dañaron 3 leches y 2 panes" → dos objetos en la lista.
- En "campos" SOLO incluye lo que el usuario pidió cambiar, omite el resto.
- "eliminar": true → desactiva el producto del inventario. Solo úsalo si el usuario quiere eliminar/quitar el producto completo.
- Para STOCK: calcula el valor final. "se dañaron 5 leches" → campos: {"stock": stock_actual - 5}. "pon en cero las cocas" → {"stock": 0}. "ajusta arroz a 20" → {"stock": 20}.
- Ejemplos de otros campos:
  · "sube la coca a 3 soles" → {"precio_venta": 3}
  · "el costo de la leche es 2.50" → {"precio_costo": 2.50}
  · "cámbiale el nombre a X" → {"nombre": "X"}
  · "la leche vence el 30 de julio" → {"fecha_vencimiento": "2026-07-30"}
  · "avísame cuando queden menos de 5 panes" → {"stock_minimo": 5}
  · "cambia la categoría a bebidas" → {"categoria": "bebidas"}
- Si no queda claro cuántas unidades quedan tras una merma, PREGUNTA antes.

CONFIRMACIÓN OBLIGATORIA para acciones destructivas:
- Si el usuario quiere ELIMINAR un producto o poner stock en 0, y NO ha confirmado explícitamente en este mensaje, PRIMERO pregunta en texto normal: "¿Seguro que quieres eliminar [producto]? Confírmame y lo hago." NO uses <EDITAR> todavía.
- Solo usa <EDITAR> con eliminar:true cuando el usuario ya confirmó (dijo "sí", "confirmo", "elimínalo", "dale", etc.).

Cuando el usuario quiere ANULAR LA ÚLTIMA VENTA (frases como "anula la última venta", "me equivoqué en la venta", "devuelve esa venta", "borra la venta"),
responde EXCLUSIVAMENTE así:
<ANULAR>
{"mensaje": "Listo, anulé la última venta y devolví el stock."}
</ANULAR>

Para CONSULTAS sobre ventas, valor de inventario, ganancia, productos más vendidos, qué está por vencer o qué tiene stock bajo:
USA LOS DATOS que tienes arriba en "DATOS DE LA TIENDA" e "INVENTARIO ACTUAL" y responde en texto normal o con tabla. NO inventes números, usa los datos reales que te di.

Para CÁLCULOS de vuelto o totales (frases como "cobré con 50", "cuánto es 3 cocas y 2 panes"):
Calcula y responde en texto normal. Ej: "Son S/7.50. Tu vuelto de S/50 es S/42.50."

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
        let prod = buscarProductoPorNombre(item.nombre_buscado, productos);

        // Si el producto NO existe y tenemos precio_venta → crearlo automáticamente
        if (!prod) {
          if (!item.precio_venta) {
            return {
              respuesta: `"${item.nombre_buscado}" no está en el inventario. ¿A cuánto lo vas a vender?`,
              accion: null,
            };
          }
          // Crear el producto nuevo
          const nuevoProd = {
            nombre: item.nombre_buscado,
            categoria: item.categoria || 'general',
            precio_venta: item.precio_venta,
            precio_costo: item.precio_costo || 0,
            stock: 0, // el trigger sumará la cantidad al registrar la entrada
            stock_minimo: 5,
            unidad: item.unidad || 'unidad',
            activo: true,
          };
          const resultado = await saveProducto(nuevoProd, usuario?.tienda_id);
          prod = resultado.producto;
          // Recargar para tener el id correcto
          if (!prod) {
            const todosProds = await getProductos();
            prod = buscarProductoPorNombre(item.nombre_buscado, todosProds);
          }
          if (!prod) {
            return {
              respuesta: `Hubo un error creando el producto "${item.nombre_buscado}". Intenta de nuevo.`,
              accion: null,
            };
          }
        }

        itemsResueltos.push({
          producto_id: prod.id,
          nombre_producto: prod.nombre,
          cantidad: item.cantidad,
          precio_costo: item.precio_costo || null,
          es_nuevo: !buscarProductoPorNombre(item.nombre_buscado, productos), // para el mensaje
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

  // ── Parsear EDITAR (múltiples productos) ────────────────────────────────────
  const editarMatch = texto.match(/<EDITAR>([\s\S]*?)<\/EDITAR>/);
  if (editarMatch) {
    try {
      const parsed = JSON.parse(editarMatch[1].trim());
      const ediciones = [];
      for (const item of parsed.productos) {
        const prod = buscarProductoPorNombre(item.nombre_buscado, productos);
        if (!prod) {
          return { respuesta: `No encontré "${item.nombre_buscado}" en el inventario.`, accion: null };
        }
        ediciones.push({
          producto_id: prod.id,
          nombre_producto: prod.nombre,
          eliminar: item.eliminar === true,
          campos: item.campos || {},
        });
      }
      return {
        respuesta: parsed.mensaje,
        accion: { tipo: 'editar', ediciones },
      };
    } catch (e) { console.error('Error EDITAR:', e); }
  }

  // ── Parsear ANULAR ──────────────────────────────────────────────────────────
  const anularMatch = texto.match(/<ANULAR>([\s\S]*?)<\/ANULAR>/);
  if (anularMatch) {
    try {
      const parsed = JSON.parse(anularMatch[1].trim());
      return { respuesta: parsed.mensaje, accion: { tipo: 'anular' } };
    } catch (e) { console.error('Error ANULAR:', e); }
  }

  // ── Respuesta normal ────────────────────────────────────────────────────────
  return { respuesta: texto, accion: null };
}

// ─── Handler principal (Vercel) ───────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { action } = body;
    let result;

    switch (action) {
      case 'auth':
        result = await handleAuth(body);
        break;

      case 'registro':
        result = await registrarTienda(body);
        break;

      case 'getProductos':
        result = await getProductos(body.tienda_id);
        break;

      case 'saveProducto':
        result = await saveProducto(body.producto, body.tienda_id);
        break;

      case 'getVentas':
        result = await getVentas(body.fechaInicio, body.fechaFin, body.tienda_id);
        break;

      case 'registrarVenta':
        result = await registrarVenta(body);
        break;

      case 'registrarEntrada':
        result = await registrarEntrada(body);
        break;

      case 'getVendedores':
        result = await getVendedores(body.tienda_id);
        break;

      case 'crearVendedor':
        result = await crearVendedor(body);
        break;

      case 'desactivarVendedor':
        result = await desactivarVendedor(body.id);
        break;

      case 'ajustarStock':
        result = await ajustarStock(body);
        break;

      case 'editarProducto':
        result = await editarProducto(body);
        break;

      case 'chat': {
        const { respuesta, accion } = await handleChat(body);

        // Ejecutar acción automáticamente si la IA la detectó
        if (accion?.tipo === 'venta') {
          try {
            await registrarVenta({
              usuario_id: body.usuario?.id || null,
              tienda_id: body.usuario?.tienda_id || null,
              items: accion.items,
              origen: 'voz',
            });
          } catch (e) {
            return res.status(200).json({ respuesta: `Error al registrar venta: ${e.message}` });
          }
        }

        if (accion?.tipo === 'entrada') {
          try {
            for (const item of accion.items) {
              await registrarEntrada({
                usuario_id: body.usuario?.id || null,
                tienda_id: body.usuario?.tienda_id || null,
                producto_id: item.producto_id,
                cantidad: item.cantidad,
                precio_costo: item.precio_costo,
                origen: 'voz',
              });
            }
          } catch (e) {
            return res.status(200).json({ respuesta: `Error al registrar entrada: ${e.message}` });
          }
        }

        // Ejecutar acciones que modifican datos
        try {
          if (accion?.tipo === 'editar') {
            for (const ed of accion.ediciones) {
              if (ed.eliminar) {
                await ajustarStock({ producto_id: ed.producto_id, desactivar: true });
              } else {
                await editarProducto({ producto_id: ed.producto_id, campos: ed.campos });
              }
            }
          } else if (accion?.tipo === 'anular') {
            const r = await anularUltimaVenta({ tienda_id: body.usuario?.tienda_id });
            if (!r.ok) return res.status(200).json({ respuesta: r.error || 'No se pudo anular la venta' });
          }
        } catch (e) {
          return res.status(200).json({ respuesta: `Error: ${e.message}` });
        }

        result = { respuesta, accion };
        break;
      }

      default:
        return res.status(400).json({ error: 'Acción no reconocida' });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('[BodegaAPI ERROR]', { timestamp: new Date().toISOString(), error: err.message, stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
};
