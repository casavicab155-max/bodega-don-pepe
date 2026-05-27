// =============================================
// Bodega Don Pepe — Función Serverless
// Netlify Functions + Anthropic Claude + Supabase
// =============================================

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
  if (user.password_hash !== password) return { ok: false, error: 'Contraseña incorrecta' };
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
  const [usuario] = await sb('POST', 'usuarios', {
    username: nombre_admin,
    password_hash: password,
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

        result = { respuesta, accion };
        break;
      }

      default:
        return res.status(400).json({ error: 'Acción no reconocida' });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('[BodegaAPI]', err);
    return res.status(500).json({ error: err.message });
  }
};
