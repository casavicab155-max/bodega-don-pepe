// =============================================
// Dona — Función Serverless v2.0
// Etapa 2: Fiado, Promociones, Reportes, Nota de venta, Asesoría IA
// =============================================

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
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

// ─── Helper: generar código de tienda desde nombre ───────────────────────────
function generarCodigo(nombre) {
  return nombre.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12);
}

// ─── Autenticación ───────────────────────────────────────────────────────────
async function handleAuth({ username, password }) {
  let user = null;

  // Formato nuevo: codigo.usuario (ej: reyes.maria o reyes.Maria — insensible a mayúsculas)
  if (username.includes('.')) {
    const dotIdx = username.indexOf('.');
    const codigo = username.slice(0, dotIdx).toLowerCase().trim();
    const uname  = username.slice(dotIdx + 1).trim();
    const tiendas = await sb('GET', `tiendas?codigo=eq.${encodeURIComponent(codigo)}`);
    if (tiendas && tiendas.length > 0) {
      // ilike = búsqueda insensible a mayúsculas en Supabase
      const rows = await sb('GET', `usuarios?username=ilike.${encodeURIComponent(uname)}&tienda_id=eq.${tiendas[0].id}&activo=eq.true`);
      user = rows?.[0] || null;
    }
  }

  // Compatibilidad hacia atrás: buscar por username global (insensible a mayúsculas)
  if (!user) {
    const rows = await sb('GET', `usuarios?username=ilike.${encodeURIComponent(username)}&activo=eq.true`);
    user = rows?.[0] || null;
  }

  if (!user) return { ok: false, error: 'Usuario no encontrado' };

  let passwordOk = false;
  if (user.password_hash && user.password_hash.startsWith('$2')) {
    passwordOk = await bcrypt.compare(password, user.password_hash);
  } else {
    passwordOk = user.password_hash === password;
    if (passwordOk) {
      const hashed = await bcrypt.hash(password, 10);
      await sb('PATCH', `usuarios?id=eq.${user.id}`, { password_hash: hashed });
    }
  }
  if (!passwordOk) return { ok: false, error: 'Contraseña incorrecta' };

  const tiendas = await sb('GET', `tiendas?id=eq.${user.tienda_id}`);
  const tienda = tiendas?.[0];
  const nombre_tienda = tienda?.nombre || '';
  const codigo_tienda = tienda?.codigo || '';
  return {
    ok: true,
    user: { id: user.id, username: user.username, nombre: user.nombre, rol: user.rol, tienda_id: user.tienda_id, nombre_tienda, codigo_tienda },
  };
}

// ─── Registrar nueva tienda ───────────────────────────────────────────────────
async function registrarTienda({ nombre_tienda, nombre_admin, password, whatsapp, ciudad }) {
  if (!nombre_tienda || !nombre_admin || !password) return { ok: false, error: 'Faltan datos obligatorios' };
  const existente = await sb('GET', `usuarios?username=eq.${encodeURIComponent(nombre_admin)}`);
  if (existente && existente.length > 0) return { ok: false, error: 'Ese nombre de usuario ya existe' };

  // Generar código único para la tienda
  let codigo = generarCodigo(nombre_tienda);
  const codigoExiste = await sb('GET', `tiendas?codigo=eq.${encodeURIComponent(codigo)}`);
  if (codigoExiste && codigoExiste.length > 0) codigo = codigo + Math.floor(Math.random() * 90 + 10);

  const [tienda] = await sb('POST', 'tiendas', {
    nombre: nombre_tienda, propietario: nombre_admin, plan: 'basico', codigo,
    whatsapp: whatsapp || null, ciudad: ciudad || null,
  });
  const hashedPassword = await bcrypt.hash(password, 10);
  const [usuario] = await sb('POST', 'usuarios', {
    username: nombre_admin, password_hash: hashedPassword, nombre: nombre_admin, rol: 'admin', tienda_id: tienda.id,
  });
  return {
    ok: true,
    user: { id: usuario.id, username: usuario.username, nombre: usuario.nombre, rol: usuario.rol, tienda_id: tienda.id, codigo_tienda: codigo, nombre_tienda: tienda.nombre },
    tienda: { id: tienda.id, nombre: tienda.nombre, codigo },
  };
}

// ─── Cambiar nombre de tienda ─────────────────────────────────────────────────
async function cambiarNombreTienda({ tienda_id, nuevo_nombre, solicitante_rol }) {
  if (solicitante_rol !== 'admin') return { ok: false, error: 'Solo el admin puede cambiar el nombre de la tienda' };
  if (!nuevo_nombre || nuevo_nombre.trim().length < 2) return { ok: false, error: 'El nombre debe tener al menos 2 caracteres' };
  await sb('PATCH', `tiendas?id=eq.${tienda_id}`, { nombre: nuevo_nombre.trim() });
  return { ok: true, nombre_tienda: nuevo_nombre.trim() };
}

// ─── Gestión de vendedores ────────────────────────────────────────────────────
async function getVendedores(tienda_id) {
  return sb('GET', `usuarios?tienda_id=eq.${tienda_id}&rol=eq.vendedor&activo=eq.true&order=nombre.asc`);
}
async function crearVendedor({ tienda_id, nombre, username, password }) {
  // Verificar unicidad solo dentro de la misma tienda
  const existente = await sb('GET', `usuarios?username=eq.${encodeURIComponent(username)}&tienda_id=eq.${tienda_id}`);
  if (existente && existente.length > 0) return { ok: false, error: 'Ese usuario ya existe en tu tienda' };
  const hashedVend = await bcrypt.hash(password, 10);
  await sb('POST', 'usuarios', { username, password_hash: hashedVend, nombre, rol: 'vendedor', tienda_id, activo: true });
  // Obtener código de la tienda para mostrar usuario completo
  const tiendas = await sb('GET', `tiendas?id=eq.${tienda_id}`);
  const codigo = tiendas?.[0]?.codigo || '';
  return { ok: true, username_completo: codigo ? `${codigo}.${username}` : username };
}
async function desactivarVendedor(id) {
  await sb('PATCH', `usuarios?id=eq.${id}`, { activo: false });
  return { ok: true };
}
async function cambiarPassword({ usuario_id, password_actual, nueva_password, target_id, solicitante_rol }) {
  if (!nueva_password || nueva_password.length < 6) return { ok: false, error: 'La nueva contraseña debe tener al menos 6 caracteres' };

  // Admin cambiando contraseña de un vendedor (no necesita contraseña actual)
  if (target_id && target_id !== usuario_id) {
    if (solicitante_rol !== 'admin') return { ok: false, error: 'Sin permisos' };
    const hashed = await bcrypt.hash(nueva_password, 10);
    await sb('PATCH', `usuarios?id=eq.${target_id}`, { password_hash: hashed });
    return { ok: true };
  }

  // Usuario cambiando su propia contraseña (necesita contraseña actual)
  const rows = await sb('GET', `usuarios?id=eq.${usuario_id}&activo=eq.true`);
  if (!rows || rows.length === 0) return { ok: false, error: 'Usuario no encontrado' };
  const user = rows[0];
  let actual_ok = false;
  if (user.password_hash && user.password_hash.startsWith('$2')) {
    actual_ok = await bcrypt.compare(password_actual, user.password_hash);
  } else {
    actual_ok = user.password_hash === password_actual;
  }
  if (!actual_ok) return { ok: false, error: 'La contraseña actual es incorrecta' };
  const hashed = await bcrypt.hash(nueva_password, 10);
  await sb('PATCH', `usuarios?id=eq.${usuario_id}`, { password_hash: hashed });
  return { ok: true };
}

// ─── Catálogo global de códigos de barras ────────────────────────────────────
const CATEGORIA_MAP = {
  'beverages': 'bebidas', 'drinks': 'bebidas', 'waters': 'bebidas', 'juices': 'bebidas',
  'snacks': 'snacks', 'chips': 'snacks', 'crackers': 'snacks',
  'dairies': 'lacteos', 'dairy': 'lacteos', 'milk': 'lacteos', 'yogurts': 'lacteos',
  'breads': 'panaderia', 'bakery': 'panaderia',
  'cleaning': 'limpieza', 'hygiene': 'limpieza',
  'groceries': 'abarrotes', 'cereals': 'abarrotes', 'pastas': 'abarrotes',
};

function mapCategoria(tags = []) {
  for (const tag of tags) {
    const key = tag.replace('en:', '').toLowerCase();
    if (CATEGORIA_MAP[key]) return CATEGORIA_MAP[key];
  }
  return 'general';
}

function mapUnidad(quantity = '') {
  const q = quantity.toLowerCase();
  if (q.includes('ml') || q.includes('l ') || q.includes('lt')) return 'botella';
  if (q.includes('kg') || q.includes('g ') || q.includes('gr')) return 'kg';
  if (q.includes('pack') || q.includes('paq')) return 'paquete';
  return 'unidad';
}

async function buscarCatalogo({ codigo_barras }) {
  if (!codigo_barras) return { ok: false, error: 'Código requerido' };

  // 1. Buscar en catálogo propio
  const local = await sb('GET', `catalogo_global?codigo_barras=eq.${encodeURIComponent(codigo_barras)}`);
  if (local && local.length > 0) {
    return { ok: true, fuente: 'dona', producto: local[0] };
  }

  // 2. Fallback: Open Food Facts (gratuito, sin API key)
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${codigo_barras}?fields=product_name,brands,categories_tags,quantity`, {
      headers: { 'User-Agent': 'Dona-Bodega/1.0 (contacto@dona.pe)' },
    });
    if (r.ok) {
      const data = await r.json();
      if (data.status === 1 && data.product) {
        const p = data.product;
        const nombre = (p.product_name || '').trim();
        if (nombre) {
          const entrada = {
            codigo_barras,
            nombre,
            marca: (p.brands || '').split(',')[0].trim() || null,
            categoria: mapCategoria(p.categories_tags || []),
            unidad: mapUnidad(p.quantity || ''),
          };
          // Guardar para la próxima vez (ignorar error si ya existe)
          await sb('POST', 'catalogo_global', entrada).catch(() => {});
          return { ok: true, fuente: 'openfoodfacts', producto: entrada };
        }
      }
    }
  } catch (_) {}

  return { ok: false, error: 'Producto no encontrado en el catálogo' };
}

async function guardarEnCatalogo({ codigo_barras, nombre, marca, categoria, unidad }) {
  if (!codigo_barras || !nombre) return { ok: false };
  await sb('POST', 'catalogo_global', { codigo_barras, nombre, marca: marca || null, categoria: categoria || 'general', unidad: unidad || 'unidad' })
    .catch(() => sb('PATCH', `catalogo_global?codigo_barras=eq.${encodeURIComponent(codigo_barras)}`, { nombre, marca, categoria, unidad }));
  return { ok: true };
}

// ─── Productos ────────────────────────────────────────────────────────────────
async function getProductos(tienda_id) {
  if (tienda_id) return sb('GET', `productos?activo=eq.true&tienda_id=eq.${tienda_id}&order=nombre.asc`);
  return sb('GET', 'productos?activo=eq.true&order=nombre.asc');
}
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
async function ajustarStock({ producto_id, nuevo_stock, desactivar = false }) {
  if (desactivar) {
    await sb('PATCH', `productos?id=eq.${producto_id}`, { activo: false });
  } else {
    await sb('PATCH', `productos?id=eq.${producto_id}`, { stock: nuevo_stock });
  }
  return { ok: true };
}
async function editarProducto({ producto_id, campos }) {
  const permitidos = ['nombre', 'categoria', 'precio_venta', 'precio_costo', 'stock', 'stock_minimo', 'unidad', 'fecha_vencimiento', 'codigo_barras'];
  const data = {};
  for (const k of permitidos) {
    if (campos[k] !== undefined && campos[k] !== null) data[k] = campos[k];
  }
  if (Object.keys(data).length === 0) return { ok: false, error: 'No hay campos para actualizar' };
  await sb('PATCH', `productos?id=eq.${producto_id}`, data);
  return { ok: true };
}

// ─── Ventas ───────────────────────────────────────────────────────────────────
async function getVentas(fechaInicio, fechaFin, tienda_id) {
  let query = 'ventas?order=created_at.desc';
  if (tienda_id) query += `&tienda_id=eq.${tienda_id}`;
  if (fechaInicio) query += `&created_at=gte.${fechaInicio}`;
  if (fechaFin) query += `&created_at=lte.${fechaFin}T23:59:59`;
  const ventas = await sb('GET', query);
  const prods = await getProductos(tienda_id);
  const prodMap = Object.fromEntries(prods.map(p => [p.id, p]));
  const enriched = await Promise.all(ventas.map(async (v) => {
    const detalles = await sb('GET', `detalle_ventas?venta_id=eq.${v.id}`);
    return {
      ...v,
      items: detalles.map(d => ({
        ...d,
        nombre_producto: prodMap[d.producto_id]?.nombre || 'Desconocido',
        precio_costo: prodMap[d.producto_id]?.precio_costo || 0,
      })),
    };
  }));
  return enriched;
}
async function registrarVenta({ usuario_id, tienda_id, items, metodo_pago = 'efectivo', origen = 'manual', es_fiado = false, cliente_nombre = null }) {
  if (!items || items.length === 0) throw new Error('La venta no tiene productos');
  const total = items.reduce((sum, i) => sum + i.precio_unitario * i.cantidad, 0);
  const [venta] = await sb('POST', 'ventas', { usuario_id, tienda_id, total, metodo_pago, origen, es_fiado: es_fiado || false, cliente_nombre: cliente_nombre || null });
  for (const item of items) {
    await sb('POST', 'detalle_ventas', {
      venta_id: venta.id, producto_id: item.producto_id, cantidad: item.cantidad, precio_unitario: item.precio_unitario,
    });
  }
  return { ok: true, venta_id: venta.id, total, es_fiado, cliente_nombre };
}
async function registrarEntrada({ usuario_id, tienda_id, producto_id, cantidad, precio_costo, proveedor, origen = 'manual', unidades_regalo = 0 }) {
  // Si hay unidades de regalo, recalcular el costo unitario real
  let costo_real = precio_costo;
  if (unidades_regalo > 0 && precio_costo && cantidad > 0) {
    const total_pagado = precio_costo * cantidad;
    const total_unidades = cantidad + unidades_regalo;
    costo_real = parseFloat((total_pagado / total_unidades).toFixed(4));
  }
  const cantidad_total = cantidad + (unidades_regalo || 0);
  await sb('POST', 'entradas_mercaderia', {
    usuario_id, tienda_id, producto_id, cantidad: cantidad_total, precio_costo: costo_real, proveedor, origen,
  });
  // Actualizar precio_costo del producto si se proporcionó
  if (costo_real) {
    await sb('PATCH', `productos?id=eq.${producto_id}`, { precio_costo: costo_real });
  }
  return { ok: true };
}
async function anularUltimaVenta({ tienda_id }) {
  const ventas = await sb('GET', `ventas?tienda_id=eq.${tienda_id}&order=created_at.desc&limit=1`);
  if (!ventas || ventas.length === 0) return { ok: false, error: 'No hay ventas para anular' };
  const venta = ventas[0];
  const detalles = await sb('GET', `detalle_ventas?venta_id=eq.${venta.id}`);
  for (const d of detalles) {
    const [prod] = await sb('GET', `productos?id=eq.${d.producto_id}`);
    if (prod) await sb('PATCH', `productos?id=eq.${d.producto_id}`, { stock: prod.stock + d.cantidad });
  }
  await sb('DELETE', `detalle_ventas?venta_id=eq.${venta.id}`);
  await sb('DELETE', `ventas?id=eq.${venta.id}`);
  return { ok: true, total: venta.total };
}

// ─── Fiado ────────────────────────────────────────────────────────────────────
async function getFiados(tienda_id) {
  const fiados = await sb('GET', `ventas?tienda_id=eq.${tienda_id}&es_fiado=eq.true&order=created_at.desc`);
  // Agrupar por cliente y calcular deuda total
  const porCliente = {};
  for (const f of fiados) {
    const nombre = f.cliente_nombre || 'Sin nombre';
    if (!porCliente[nombre]) {
      porCliente[nombre] = { cliente: nombre, total_deuda: 0, ventas: [] };
    }
    const pagado = f.monto_pagado || 0;
    const pendiente = parseFloat(f.total) - pagado;
    if (pendiente > 0) {
      porCliente[nombre].total_deuda += pendiente;
      porCliente[nombre].ventas.push({ id: f.id, total: f.total, pendiente, fecha: f.created_at });
    }
  }
  return Object.values(porCliente).filter(c => c.total_deuda > 0);
}
async function registrarPagoFiado({ tienda_id, cliente_nombre, monto }) {
  // Obtener ventas fiadas pendientes del cliente, ordenadas por fecha
  const fiados = await sb('GET',
    `ventas?tienda_id=eq.${tienda_id}&es_fiado=eq.true&cliente_nombre=eq.${encodeURIComponent(cliente_nombre)}&order=created_at.asc`
  );
  let montoRestante = parseFloat(monto);
  let totalPagado = 0;
  for (const f of fiados) {
    if (montoRestante <= 0) break;
    const pendiente = parseFloat(f.total) - (f.monto_pagado || 0);
    if (pendiente <= 0) continue;
    const abonar = Math.min(pendiente, montoRestante);
    const nuevoPagado = (f.monto_pagado || 0) + abonar;
    await sb('PATCH', `ventas?id=eq.${f.id}`, { monto_pagado: nuevoPagado });
    montoRestante -= abonar;
    totalPagado += abonar;
  }
  return { ok: true, totalPagado: totalPagado.toFixed(2), quedaDebe: montoRestante < 0 ? 0 : montoRestante };
}

// ─── Reportes con ganancia ─────────────────────────────────────────────────────
async function getReporteGanancias({ tienda_id, fechaInicio, fechaFin }) {
  const ventas = await getVentas(fechaInicio, fechaFin, tienda_id);
  let totalVentas = 0, totalCosto = 0, totalGanancia = 0;
  for (const v of ventas) {
    if (v.es_fiado && !v.monto_pagado) continue; // excluir fiados no pagados del reporte de ingresos reales
    totalVentas += parseFloat(v.total);
    for (const item of v.items) {
      totalCosto += (item.precio_costo || 0) * item.cantidad;
    }
  }
  totalGanancia = totalVentas - totalCosto;
  const margen = totalVentas > 0 ? ((totalGanancia / totalVentas) * 100).toFixed(1) : 0;
  return {
    ok: true,
    ventas_count: ventas.filter(v => !v.es_fiado || v.monto_pagado).length,
    total_ventas: totalVentas.toFixed(2),
    total_costo: totalCosto.toFixed(2),
    ganancia: totalGanancia.toFixed(2),
    margen_pct: margen,
  };
}

// ─── Analizar factura con Vision ─────────────────────────────────────────────
async function analizarFactura({ imagen_base64, media_type, tienda_id, usuario, confirmar_duplicado = false }) {
  if (!imagen_base64) return { ok: false, error: 'No se recibió imagen' };
  if (!ANTHROPIC_API_KEY) return { ok: false, error: 'API key no configurada' };

  // 1. Hash de la imagen para detectar foto duplicada exacta
  const hash_imagen = crypto.createHash('sha256').update(imagen_base64).digest('hex').slice(0, 32);

  // 2. Claude Vision extrae los productos de la factura
  const visionRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: media_type || 'image/jpeg', data: imagen_base64 },
          },
          {
            type: 'text',
            text: `Eres un asistente que extrae datos de facturas o boletas de proveedores peruanos.
Solo procesas documentos peruanos (con RUC, soles S/, IGV, emitidos en Peru).
Si el documento no es peruano responde: {"error": "Solo se aceptan facturas peruanas"}
Si la imagen no es una factura o boleta responde: {"error": "No es una factura"}
De lo contrario, extrae TODOS los productos y responde SOLO con JSON valido, sin texto adicional:
{
  "numero_factura": "numero de serie como F001-00012345 o null si no se ve",
  "proveedor": "nombre del proveedor o null",
  "fecha": "fecha en formato YYYY-MM-DD o null",
  "productos": [
    {
      "nombre": "nombre del producto",
      "cantidad": numero,
      "importe_linea": numero_o_null,
      "igv_categoria": "gravada/exonerada/inafecta/null",
      "unidad": "unidad/caja/paquete/botella/kg",
      "categoria": "bebidas/abarrotes/snacks/lacteos/panaderia/limpieza/general"
    }
  ]
}
importe_linea: valor de la columna IMPORTE o SUBTOTAL de esa linea (ya incluye descuentos, NO incluye IGV). Es el dato clave para calcular el costo real.
igv_categoria: revisa las secciones OP.GRAVADAS, OP.EXONERADAS, OP.INAFECTAS para identificar a cual pertenece cada producto. Si es boleta simple sin esas secciones pon null.
Si no puedes leer algun campo con certeza ponlo en null.`,
          },
        ],
      }],
    }),
  });

  if (!visionRes.ok) throw new Error(`Vision API error: ${visionRes.status}`);
  const visionData = await visionRes.json();
  const textoRespuesta = visionData.content[0].text.trim();

  let facturaData;
  try {
    const jsonMatch = textoRespuesta.match(/\{[\s\S]*\}/);
    facturaData = JSON.parse(jsonMatch ? jsonMatch[0] : textoRespuesta);
  } catch {
    return { ok: false, error: 'No pude leer la factura. ¿Puedes tomar la foto más cerca y con mejor luz?' };
  }

  if (facturaData.error) return { ok: false, error: facturaData.error };
  if (!facturaData.productos || facturaData.productos.length === 0) {
    return { ok: false, error: 'No encontré productos en la imagen. Intenta con una foto más clara.' };
  }

  // 3. Verificar duplicado (salvo que el usuario confirmó que quiere registrarla igual)
  if (!confirmar_duplicado) {
    const checksPromises = [];
    if (facturaData.numero_factura)
      checksPromises.push(sb('GET', `facturas_registradas?tienda_id=eq.${tienda_id}&numero_factura=eq.${encodeURIComponent(facturaData.numero_factura)}`));
    checksPromises.push(sb('GET', `facturas_registradas?tienda_id=eq.${tienda_id}&hash_imagen=eq.${hash_imagen}`));
    const resultChecks = await Promise.all(checksPromises);
    const dupNumero = (facturaData.numero_factura && resultChecks[0]?.length > 0) ? resultChecks[0][0] : null;
    const dupHash = resultChecks[resultChecks.length - 1]?.length > 0 ? resultChecks[resultChecks.length - 1][0] : null;
    if (dupNumero || dupHash) {
      const reg = dupNumero || dupHash;
      const fechaReg = new Date(reg.created_at).toLocaleDateString('es-PE', { day: 'numeric', month: 'long' });
      const razon = dupNumero ? `la factura ${facturaData.numero_factura}` : 'esta misma foto';
      return {
        ok: false,
        es_duplicado: true,
        hash_imagen,
        numero_factura: facturaData.numero_factura,
        proveedor: facturaData.proveedor,
        mensaje_duplicado: `Ya registre ${razon} el ${fechaReg}${reg.proveedor ? ' de ' + reg.proveedor : ''}. Si la registras de nuevo el stock se sumara otra vez. Quieres registrarla igual?`,
      };
    }
  }

  // 4. Obtener inventario actual de la tienda
  const productosExistentes = await getProductos(tienda_id);
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

  const resultados = { nuevos: [], actualizados: [], precio_cambio: [], sin_precio_venta: [] };

  for (const item of facturaData.productos) {
    if (!item.nombre || !item.cantidad) continue;
    const cantidad = parseFloat(item.cantidad) || 0;
    if (cantidad <= 0) continue;
    const igv_factor = item.igv_categoria === 'gravada' ? 1.18 : 1.0;
    // Preferir importe_linea (ya incluye descuentos, sin impuesto) para calcular costo real
    let precio_costo = 0;
    if (item.importe_linea && parseFloat(item.importe_linea) > 0) {
      precio_costo = parseFloat(((parseFloat(item.importe_linea) / cantidad) * igv_factor).toFixed(2));
    } else if (item.precio_costo_unitario && parseFloat(item.precio_costo_unitario) > 0) {
      precio_costo = parseFloat((parseFloat(item.precio_costo_unitario) * igv_factor).toFixed(2));
    }

    // Buscar si el producto ya existe
    const existente = productosExistentes.find(p => norm(p.nombre) === norm(item.nombre)) ||
      productosExistentes.find(p => norm(p.nombre).includes(norm(item.nombre)) || norm(item.nombre).includes(norm(p.nombre)));

    if (existente) {
      // Sumar stock
      const nuevo_stock = (parseFloat(existente.stock) || 0) + cantidad;
      const data = { stock: nuevo_stock };

      // Detectar cambio de precio de costo
      const costo_anterior = parseFloat(existente.precio_costo) || 0;
      if (precio_costo > 0 && Math.abs(precio_costo - costo_anterior) > 0.01) {
        data.precio_costo = precio_costo;
        resultados.precio_cambio.push({
          nombre: existente.nombre,
          costo_anterior: costo_anterior.toFixed(2),
          costo_nuevo: precio_costo.toFixed(2),
        });
      } else if (precio_costo > 0) {
        data.precio_costo = precio_costo;
      }

      await sb('PATCH', `productos?id=eq.${existente.id}`, data);

      // Registrar entrada
      await sb('POST', 'entradas_mercaderia', {
        usuario_id: usuario?.id || null,
        tienda_id,
        producto_id: existente.id,
        cantidad,
        precio_costo: precio_costo || existente.precio_costo,
        proveedor: facturaData.proveedor || null,
        origen: 'factura',
      }).catch(() => {});

      resultados.actualizados.push({ nombre: existente.nombre, cantidad, stock_nuevo: nuevo_stock });
    } else {
      // Producto nuevo — crear sin precio de venta por ahora
      if (precio_costo > 0) {
        const nuevoProducto = {
          nombre: item.nombre,
          categoria: item.categoria || 'general',
          unidad: item.unidad || 'unidad',
          precio_costo,
          precio_venta: 0, // Se pedirá al usuario
          stock: cantidad,
          stock_minimo: 5,
          activo: true,
          tienda_id,
        };
        const [creado] = await sb('POST', 'productos', nuevoProducto);
        await sb('POST', 'entradas_mercaderia', {
          usuario_id: usuario?.id || null,
          tienda_id,
          producto_id: creado.id,
          cantidad,
          precio_costo,
          proveedor: facturaData.proveedor || null,
          origen: 'factura',
        }).catch(() => {});
        resultados.nuevos.push({ nombre: item.nombre, cantidad, precio_costo });
        resultados.sin_precio_venta.push(item.nombre);
      } else {
        // Sin precio de costo tampoco → pedir ambos
        resultados.nuevos.push({ nombre: item.nombre, cantidad, precio_costo: null });
        resultados.sin_precio_venta.push(item.nombre);
      }
    }
  }

  // 5. Guardar huella de la factura para detección futura
  await sb('POST', 'facturas_registradas', {
    tienda_id,
    numero_factura: facturaData.numero_factura || null,
    proveedor: facturaData.proveedor || null,
    fecha_factura: facturaData.fecha || null,
    hash_imagen,
  }).catch(() => {});

  // 6. Construir mensaje de respuesta
  let respuesta = '';
  if (facturaData.numero_factura || facturaData.proveedor) {
    respuesta += '📄 **';
    if (facturaData.numero_factura) respuesta += facturaData.numero_factura;
    if (facturaData.numero_factura && facturaData.proveedor) respuesta += ' — ';
    if (facturaData.proveedor) respuesta += facturaData.proveedor;
    respuesta += '**\n\n';
  }

  if (resultados.actualizados.length > 0) {
    respuesta += `✅ **Actualicé el stock de ${resultados.actualizados.length} producto(s):**\n`;
    respuesta += resultados.actualizados.map(p => `• ${p.nombre}: +${p.cantidad} unid. (stock total: ${p.stock_nuevo})`).join('\n');
    respuesta += '\n\n';
  }

  if (resultados.precio_cambio.length > 0) {
    respuesta += `⚠️ **Cambio de precio de costo detectado:**\n`;
    respuesta += resultados.precio_cambio.map(p => `• ${p.nombre}: S/${p.costo_anterior} → S/${p.costo_nuevo}`).join('\n');
    respuesta += '\n¿Quieres ajustar el precio de venta de alguno?\n\n';
  }

  if (resultados.nuevos.length > 0) {
    respuesta += `🆕 **Productos nuevos agregados (${resultados.nuevos.length}):**\n`;
    respuesta += resultados.nuevos.map(p => `• ${p.nombre}: ${p.cantidad} unid.${p.precio_costo ? ` (costo: S/${p.precio_costo})` : ''}`).join('\n');
    respuesta += '\n\n';
  }

  if (resultados.sin_precio_venta.length > 0) {
    respuesta += `💰 **Falta el precio de venta para:**\n`;
    respuesta += resultados.sin_precio_venta.map(n => `• ${n}`).join('\n');
    respuesta += '\n\nDime el precio de cada uno para que tus clientes puedan comprarlos.';
  }

  if (!respuesta) respuesta = 'Procesé la factura pero no encontré productos claros. Intenta con una foto más nítida.';

  return { ok: true, respuesta, resultados };
}

// ─── Buscar producto por nombre ───────────────────────────────────────────────
function buscarProductoPorNombre(nombre, productos, precio_unitario = null) {
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const n = norm(nombre);

  // 1. Coincidencia exacta
  let found = productos.find(p => norm(p.nombre) === n);
  if (found) return found;

  // 2. Recolectar candidatos con coincidencia parcial
  let candidatos = productos.filter(p => {
    const pn = norm(p.nombre);
    return pn.includes(n) || n.includes(pn) || n.includes(pn.split(' ')[0]);
  });

  if (candidatos.length === 0) return null;
  if (candidatos.length === 1) return candidatos[0];

  // 3. Múltiples candidatos: desambiguar por precio_unitario si está disponible
  if (precio_unitario && precio_unitario > 0) {
    const TOLERANCIA = 0.10; // ±S/0.10
    const porPrecio = candidatos.filter(p =>
      Math.abs(parseFloat(p.precio_venta) - precio_unitario) <= TOLERANCIA
    );
    if (porPrecio.length === 1) return porPrecio[0];
    if (porPrecio.length > 1) candidatos = porPrecio;
  }

  // 4. Último recurso: nombre más parecido en longitud
  return candidatos.sort((a, b) =>
    Math.abs(a.nombre.length - nombre.length) - Math.abs(b.nombre.length - nombre.length)
  )[0];
}

// ─── IA Chat principal ────────────────────────────────────────────────────────
async function handleChat({ mensaje, usuario, historial = [] }) {
  const tienda_id = usuario?.tienda_id;
  const productos = await getProductos(tienda_id);

  const hoy = new Date().toLocaleDateString('es-PE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const inventarioTexto = productos.length > 0
    ? productos.map(p => {
        const venc = p.fecha_vencimiento
          ? ` | Vence: ${new Date(p.fecha_vencimiento).toLocaleDateString('es-PE')}`
          : '';
        const alerta = p.stock <= p.stock_minimo ? ' ⚠️ STOCK BAJO' : '';
        const costo = p.precio_costo ? ` | Costo: S/${p.precio_costo}` : '';
        return `- ${p.nombre} (id:${p.id}) | Stock: ${p.stock} ${p.unidad || 'unidad'}s | Precio: S/${p.precio_venta}${costo}${venc}${alerta}`;
      }).join('\n')
    : 'Sin productos registrados aún.';

  // Métricas del inventario
  const valorInventario = productos.reduce((s, p) => s + (p.precio_venta * p.stock), 0).toFixed(2);
  const costoInventario = productos.reduce((s, p) => s + ((p.precio_costo || 0) * p.stock), 0).toFixed(2);
  const gananciaPotencial = (parseFloat(valorInventario) - parseFloat(costoInventario)).toFixed(2);
  const productosStockBajo = productos.filter(p => p.stock <= p.stock_minimo).map(p => p.nombre).join(', ') || 'ninguno';
  const productosPorVencer = productos.filter(p => {
    if (!p.fecha_vencimiento) return false;
    const dias = Math.floor((new Date(p.fecha_vencimiento) - new Date()) / 86400000);
    return dias >= 0 && dias <= 30;
  }).map(p => {
    const dias = Math.floor((new Date(p.fecha_vencimiento) - new Date()) / 86400000);
    return `${p.nombre} (${dias}d)`;
  }).join(', ') || 'ninguno';

  // Ventas de hoy con ganancia
  let ventasHoyTexto = '';
  let gananciasHoyTexto = '';
  try {
    const hoyIni = new Date(); hoyIni.setHours(0,0,0,0);
    const ventasHoy = await sb('GET', `ventas?tienda_id=eq.${tienda_id}&created_at=gte.${hoyIni.toISOString()}&es_fiado=eq.false`);
    const totalHoy = ventasHoy.reduce((s, v) => s + parseFloat(v.total), 0).toFixed(2);
    ventasHoyTexto = `Ventas de hoy: ${ventasHoy.length} ventas en efectivo, total S/${totalHoy}`;

    // Calcular ganancia de hoy
    let costoHoy = 0;
    for (const v of ventasHoy) {
      const detalles = await sb('GET', `detalle_ventas?venta_id=eq.${v.id}`);
      for (const d of detalles) {
        const prod = productos.find(p => p.id === d.producto_id);
        costoHoy += (prod?.precio_costo || 0) * d.cantidad;
      }
    }
    const gananciaHoy = (parseFloat(totalHoy) - costoHoy).toFixed(2);
    const margenHoy = parseFloat(totalHoy) > 0 ? ((gananciaHoy / totalHoy) * 100).toFixed(0) : 0;
    gananciasHoyTexto = `Ganancia de hoy: S/${gananciaHoy} (margen ${margenHoy}%)`;

    // Fiados pendientes
    const fiadosHoy = await sb('GET', `ventas?tienda_id=eq.${tienda_id}&es_fiado=eq.true`);
    const totalFiado = fiadosHoy.reduce((s, v) => s + parseFloat(v.total) - (v.monto_pagado || 0), 0).toFixed(2);
    if (parseFloat(totalFiado) > 0) {
      ventasHoyTexto += ` | Fiados pendientes: S/${totalFiado}`;
    }
  } catch { ventasHoyTexto = ''; }

  const systemPrompt = `Eres Dona, la asistente inteligente de una bodega peruana.
Hoy es ${hoy}. Atiendes a ${usuario?.nombre || 'el vendedor'} (${usuario?.rol || 'vendedor'}).

=== INVENTARIO ACTUAL ===
${inventarioTexto}

=== MÉTRICAS DE LA TIENDA ===
Valor inventario (precio venta): S/${valorInventario}
Costo del inventario: S/${costoInventario}
Ganancia potencial: S/${gananciaPotencial}
Productos con stock bajo: ${productosStockBajo}
Productos por vencer (≤30 días): ${productosPorVencer}
${ventasHoyTexto}
${gananciasHoyTexto}

=== TU COMPORTAMIENTO ===
Eres Dona, asistente especializada en bodegas peruanas. Hablas en español peruano, amigable y directo.
Cuando no hay datos de costo, no inventes ganancias.

--- REGISTRAR VENTA ---
Cuando el usuario vende algo (frases: "vendí", "el cliente llevó", "despachamos", etc.):
<VENTA>
{
  "mensaje": "Listo, registré la venta. Total: S/[monto].",
  "items": [{"nombre_buscado": "nombre", "cantidad": número, "precio_unitario": número_o_null}],
  "metodo_pago": "efectivo"
}
</VENTA>
- "precio_unitario": si el usuario da precio total, calcúlalo (total ÷ cantidad). Si da precio unitario, úsalo directo. Si no hay precio, pon null.
  Ejemplo: "vendí 2 Inca Kolas a 6 soles" → precio_unitario: 3.00 | "vendí 3 leches a S/4.50 cada una" → precio_unitario: 4.50
- El precio_unitario permite elegir la presentación correcta cuando hay varias del mismo producto (500ml vs 1.5L).
- Si el usuario dice "al contado" → metodo_pago: "efectivo"
- Si dice "con yape/plin" → metodo_pago: "yape"
- Si stock es insuficiente NO registres la venta, avisa al usuario.

--- REGISTRAR FIADO ---
Cuando el usuario fía algo (frases: "fíale", "al fiado", "me debe", "se lo lleva y paga después"):
<FIADO>
{
  "mensaje": "Listo, anoté el fiado de [cliente]. Debe S/[monto].",
  "cliente_nombre": "nombre del cliente",
  "items": [{"nombre_buscado": "nombre", "cantidad": número, "precio_unitario": número_o_null}]
}
</FIADO>
Si no dice el nombre del cliente, PREGUNTA antes: "¿A nombre de quién anoto el fiado?"

--- PAGO DE FIADO ---
Cuando alguien paga su deuda (frases: "pagó su fiado", "abonó", "me pagó [nombre]"):
<PAGO_FIADO>
{
  "mensaje": "Listo, registré el pago de [cliente].",
  "cliente_nombre": "nombre",
  "monto": número
}
</PAGO_FIADO>
Si no dice el monto, pregunta: "¿Cuánto te pagó [cliente]?"

--- ENTRADA DE MERCADERÍA ---
Cuando llega mercadería (frases: "llegaron", "recibí", "entró pedido"):
<ENTRADA>
{
  "mensaje": "Listo, registré la entrada.",
  "items": [
    {
      "nombre_buscado": "nombre",
      "cantidad": número,
      "precio_costo": número_o_null,
      "precio_venta": número_o_null,
      "categoria": "texto_o_null",
      "unidad": "texto_o_null",
      "unidades_regalo": número_o_0
    }
  ]
}
</ENTRADA>
- Si el producto NO existe y no hay precio_venta, PREGUNTA: "¿A cuánto lo vas a vender?"
- Si el proveedor regaló unidades: "compraron 24 y me regalaron 4" → cantidad:24, unidades_regalo:4
  El sistema calculará automáticamente el costo real por unidad dividiendo el pago entre el total.

--- EDITAR PRODUCTO ---
Cuando el usuario quiere cambiar cualquier campo (precio, stock, nombre, categoría, unidad, stock mínimo, fecha de vencimiento) de uno o varios productos:
<EDITAR>
{
  "mensaje": "Listo, [descripción del cambio].",
  "productos": [
    {
      "nombre_buscado": "nombre",
      "eliminar": false,
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
- Puedes editar VARIOS productos a la vez.
- "se dañaron 5 leches" → campos: {"stock": stock_actual - 5}
- CONFIRMACIÓN OBLIGATORIA: Si el usuario quiere eliminar un producto o poner stock en 0, PRIMERO pregunta en texto: "¿Seguro que quieres [acción]? Confirma y lo hago." Solo usa eliminar:true tras confirmación.

--- ANULAR ÚLTIMA VENTA ---
Cuando el usuario se equivocó (frases: "anula la última venta", "me equivoqué"):
<ANULAR>
{"mensaje": "Listo, anulé la última venta y devolví el stock."}
</ANULAR>

--- CONSULTAS Y ANÁLISIS ---
Para consultas sobre ventas, ganancias, fiados, stock, productos por vencer → usa los datos reales de arriba. NO inventes números.
Para cálculos de vuelto: "cobré con 50 por S/12" → "Tu vuelto es S/38."
Para totales: "cuánto es 3 cocas y 2 panes" → calcula con los precios reales del inventario.

--- ASESORÍA DE COMPRAS Y NEGOCIACIÓN ---
Cuando el usuario pide ayuda para decidir entre opciones de proveedores o negociar precios:
- Analiza costo unitario, capital necesario, duración según ritmo de ventas, y ganancia potencial.
- Sé directo con la recomendación: "Te conviene la opción B porque..."
- Para negociación con clientes: calcula el precio mínimo sin perder margen.
Ejemplo: "Mi proveedor me da 24 cocas a S/1.80 o 48 a S/1.50 ¿cuál conviene?" → compara costo unitario, inversión y tiempo de rotación.

--- ASESORÍA GENERAL DE NEGOCIO ---
Puedes responder cualquier consulta relacionada con bodegas, ventas, atención al cliente y pequeño negocio:
- Estrategias para vender más (qué productos poner al frente, cómo agrupar productos, temporadas)
- Cómo tratar a clientes difíciles, cómo manejar reclamos, cómo fidelizar clientes
- Qué productos conviene tener según la zona o temporada
- Cómo organizar la bodega, control de fechas de vencimiento, etc.
- Cualquier pregunta de negocio que el bodeguero tenga

--- INFORMACIÓN SOBRE PRODUCTOS ---
Si el usuario pregunta para qué sirve un producto, cómo se usa, o qué se puede hacer con él:
- Responde con información útil desde la perspectiva de una bodega (cómo venderlo, a quién le interesa, si tiene buena rotación)
- Si es un ingrediente o producto poco conocido, explica sus usos y sugiere cómo promocionarlo
Ejemplo: "¿Qué hago con la chancaca que me sobró?" → "La chancaca es muy buscada para preparar api, picarones y chicha morada. Puedes ponerla cerca de la canela y clavo, los clientes que buscan uno suelen llevar los otros."

--- AYUDA Y TUTORIALES ---
Cuando el usuario diga "ayuda", "no sé cómo", "cómo funciona", "no entiendo", "qué puedo hacer", "para qué sirves", o similares:
Responde con una guía clara, paso a paso, usando ejemplos con productos reales del inventario cuando sea posible.

Guía de referencia (adapta al contexto, no copies literal):

🎤 REGISTRAR VENTA POR VOZ
  Toca el micrófono y di: "Vendí 2 Inca Kolas y un pan"
  Yo descuento el stock y registro la venta automáticamente.
  También puedes decir el total: "El cliente llevó 3 leches a 12 soles"

🛒 VENTA MANUAL
  Ve a la pestaña Ventas → busca el producto → toca + Agregar → Cobrar.

📦 AGREGAR PRODUCTOS AL INVENTARIO
  Por voz: "Registra Coca Cola 500ml a S/3, me costó S/2"
  Por foto: toca el ícono de imagen en el chat y fotografía la factura del proveedor.
  Manual: ve a Inventario → toca el botón +.

📒 FIADOS
  Por voz: "Fíale a Rosa 2 leches"
  Para ver quién te debe: ve a la pestaña Fiados.
  Para registrar un pago: "Rosa me pagó S/10"

📊 CONSULTAS Y REPORTES
  "¿Cuánto vendí hoy?" / "¿Cuánto gané esta semana?" / "¿Qué productos están por vencer?"

💡 CONSEJOS DE NEGOCIO
  Puedes preguntarme cualquier cosa sobre tu bodega: precios, proveedores, qué vender, cómo tratar clientes difíciles, etc.

Cuando respondas guías de ayuda:
- Usa lenguaje simple, como si le explicaras a alguien que nunca usó la app.
- Sé específico: usa ejemplos con productos reales del inventario si los hay.
- Nunca des más de 3 pasos por vez — si hay más, ofrece explicar el siguiente.
- Termina siempre con "¿Te ayudo con algo más?" o una pregunta de seguimiento.

--- LÍMITE DE TEMAS ---
Si el usuario pregunta algo completamente ajeno a su bodega o negocio (recetas personales, deportes, política, entretenimiento, etc.):
Responde amablemente: "Eso está fuera de mi especialidad, pero para lo que necesites de tu bodega aquí estoy 😊"
NO respondas preguntas de tarea, recetas de cocina personal, noticias, ni temas que no ayuden al negocio.

--- TABLAS ---
Cuando pidan lista, cuadro o resumen, responde con HTML:
<table>
  <thead><tr><th>Col1</th><th>Col2</th></tr></thead>
  <tbody><tr><td>dato</td><td>dato</td></tr></tbody>
</table>
Badges de stock: <span class="badge-stock ok">✓ OK</span> / <span class="badge-stock warn">⚠ Bajo</span> / <span class="badge-stock danger">🔴 Crítico</span>
Totales en verde: <td style="color:#22c55e">S/XX</td>

Para cualquier otra consulta responde en texto normal, máximo 3 oraciones.`;

  const messages = [
    ...historial.slice(-8),
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
      max_tokens: 800,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) throw new Error(`Claude API error: ${response.status}`);
  const data = await response.json();
  const texto = data.content[0].text.trim();

  // ── Parsear VENTA ────────────────────────────────────────────────────────────
  const ventaMatch = texto.match(/<VENTA>([\s\S]*?)<\/VENTA>/);
  if (ventaMatch) {
    try {
      const parsed = JSON.parse(ventaMatch[1].trim());
      const itemsResueltos = [];
      for (const item of parsed.items) {
        const prod = buscarProductoPorNombre(item.nombre_buscado, productos);
        if (!prod) return { respuesta: `No encontré "${item.nombre_buscado}" en el inventario. ¿Cómo se llama exactamente?`, accion: null };
        if (prod.stock < item.cantidad) return { respuesta: `⚠️ Solo hay ${prod.stock} ${prod.unidad || 'unidad'}s de ${prod.nombre}. ¿Cuántas deseas vender?`, accion: null };
        itemsResueltos.push({ producto_id: prod.id, nombre_producto: prod.nombre, cantidad: item.cantidad, precio_unitario: prod.precio_venta });
      }
      return { respuesta: parsed.mensaje, accion: { tipo: 'venta', items: itemsResueltos, metodo_pago: parsed.metodo_pago || 'efectivo' } };
    } catch (e) { console.error('Error VENTA:', e); }
  }

  // ── Parsear FIADO ────────────────────────────────────────────────────────────
  const fiadoMatch = texto.match(/<FIADO>([\s\S]*?)<\/FIADO>/);
  if (fiadoMatch) {
    try {
      const parsed = JSON.parse(fiadoMatch[1].trim());
      const itemsResueltos = [];
      for (const item of parsed.items) {
        const prod = buscarProductoPorNombre(item.nombre_buscado, productos);
        if (!prod) return { respuesta: `No encontré "${item.nombre_buscado}" en el inventario.`, accion: null };
        if (prod.stock < item.cantidad) return { respuesta: `⚠️ Solo hay ${prod.stock} unidades de ${prod.nombre}.`, accion: null };
        itemsResueltos.push({ producto_id: prod.id, nombre_producto: prod.nombre, cantidad: item.cantidad, precio_unitario: prod.precio_venta });
      }
      return { respuesta: parsed.mensaje, accion: { tipo: 'fiado', items: itemsResueltos, cliente_nombre: parsed.cliente_nombre } };
    } catch (e) { console.error('Error FIADO:', e); }
  }

  // ── Parsear PAGO_FIADO ───────────────────────────────────────────────────────
  const pagoFiadoMatch = texto.match(/<PAGO_FIADO>([\s\S]*?)<\/PAGO_FIADO>/);
  if (pagoFiadoMatch) {
    try {
      const parsed = JSON.parse(pagoFiadoMatch[1].trim());
      return { respuesta: parsed.mensaje, accion: { tipo: 'pago_fiado', cliente_nombre: parsed.cliente_nombre, monto: parsed.monto } };
    } catch (e) { console.error('Error PAGO_FIADO:', e); }
  }

  // ── Parsear ENTRADA ──────────────────────────────────────────────────────────
  const entradaMatch = texto.match(/<ENTRADA>([\s\S]*?)<\/ENTRADA>/);
  if (entradaMatch) {
    try {
      const parsed = JSON.parse(entradaMatch[1].trim());
      const itemsResueltos = [];
      for (const item of parsed.items) {
        let prod = buscarProductoPorNombre(item.nombre_buscado, productos);
        if (!prod) {
          if (!item.precio_venta) return { respuesta: `"${item.nombre_buscado}" no está en el inventario. ¿A cuánto lo vas a vender?`, accion: null };
          const nuevoProd = {
            nombre: item.nombre_buscado, categoria: item.categoria || 'general',
            precio_venta: item.precio_venta, precio_costo: item.precio_costo || 0,
            stock: 0, stock_minimo: 5, unidad: item.unidad || 'unidad', activo: true,
          };
          const resultado = await saveProducto(nuevoProd, usuario?.tienda_id);
          prod = resultado.producto;
          if (!prod) {
            const todosProds = await getProductos(usuario?.tienda_id);
            prod = buscarProductoPorNombre(item.nombre_buscado, todosProds);
          }
          if (!prod) return { respuesta: `Error creando "${item.nombre_buscado}". Intenta de nuevo.`, accion: null };
        }
        itemsResueltos.push({
          producto_id: prod.id, nombre_producto: prod.nombre, cantidad: item.cantidad,
          precio_costo: item.precio_costo || null, unidades_regalo: item.unidades_regalo || 0,
        });
      }
      return { respuesta: parsed.mensaje, accion: { tipo: 'entrada', items: itemsResueltos } };
    } catch (e) { console.error('Error ENTRADA:', e); }
  }

  // ── Parsear EDITAR ───────────────────────────────────────────────────────────
  const editarMatch = texto.match(/<EDITAR>([\s\S]*?)<\/EDITAR>/);
  if (editarMatch) {
    try {
      const parsed = JSON.parse(editarMatch[1].trim());
      const ediciones = [];
      for (const item of parsed.productos) {
        const prod = buscarProductoPorNombre(item.nombre_buscado, productos);
        if (!prod) return { respuesta: `No encontré "${item.nombre_buscado}" en el inventario.`, accion: null };
        ediciones.push({ producto_id: prod.id, nombre_producto: prod.nombre, eliminar: item.eliminar === true, campos: item.campos || {} });
      }
      return { respuesta: parsed.mensaje, accion: { tipo: 'editar', ediciones } };
    } catch (e) { console.error('Error EDITAR:', e); }
  }

  // ── Parsear ANULAR ───────────────────────────────────────────────────────────
  const anularMatch = texto.match(/<ANULAR>([\s\S]*?)<\/ANULAR>/);
  if (anularMatch) {
    try {
      const parsed = JSON.parse(anularMatch[1].trim());
      return { respuesta: parsed.mensaje, accion: { tipo: 'anular' } };
    } catch (e) { console.error('Error ANULAR:', e); }
  }

  return { respuesta: texto, accion: null };
}

// ─── Handler principal (Vercel) ──────────────────────────────────────────────
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
      case 'auth':           result = await handleAuth(body); break;
      case 'registro':       result = await registrarTienda(body); break;
      case 'getProductos':   result = await getProductos(body.tienda_id); break;
      case 'saveProducto':   result = await saveProducto(body.producto, body.tienda_id); break;
      case 'getVentas':      result = await getVentas(body.fechaInicio, body.fechaFin, body.tienda_id); break;
      case 'registrarVenta': result = await registrarVenta(body); break;
      case 'registrarEntrada': result = await registrarEntrada(body); break;
      case 'getVendedores':  result = await getVendedores(body.tienda_id); break;
      case 'crearVendedor':  result = await crearVendedor(body); break;
      case 'desactivarVendedor': result = await desactivarVendedor(body.id); break;
      case 'cambiarPassword':      result = await cambiarPassword(body); break;
      case 'cambiarNombreTienda':  result = await cambiarNombreTienda(body); break;
      case 'ping':                 result = { ok: true, ts: Date.now() }; break;
      case 'analizarFactura':      result = await analizarFactura(body); break;
      case 'buscarCatalogo':       result = await buscarCatalogo(body); break;
      case 'guardarEnCatalogo':    result = await guardarEnCatalogo(body); break;
      case 'ajustarStock':   result = await ajustarStock(body); break;
      case 'editarProducto': result = await editarProducto(body); break;
      case 'getFiados':      result = await getFiados(body.tienda_id); break;
      case 'registrarPagoFiado': result = await registrarPagoFiado(body); break;
      case 'getReporteGanancias': result = await getReporteGanancias(body); break;

      case 'chat': {
        const { respuesta, accion } = await handleChat(body);

        try {
          if (accion?.tipo === 'venta') {
            await registrarVenta({
              usuario_id: body.usuario?.id || null,
              tienda_id: body.usuario?.tienda_id || null,
              items: accion.items,
              metodo_pago: accion.metodo_pago || 'efectivo',
              origen: 'voz',
            });
          } else if (accion?.tipo === 'fiado') {
            await registrarVenta({
              usuario_id: body.usuario?.id || null,
              tienda_id: body.usuario?.tienda_id || null,
              items: accion.items,
              metodo_pago: 'fiado',
              origen: 'voz',
              es_fiado: true,
              cliente_nombre: accion.cliente_nombre,
            });
          } else if (accion?.tipo === 'pago_fiado') {
            await registrarPagoFiado({
              tienda_id: body.usuario?.tienda_id,
              cliente_nombre: accion.cliente_nombre,
              monto: accion.monto,
            });
          } else if (accion?.tipo === 'entrada') {
            for (const item of accion.items) {
              await registrarEntrada({
                usuario_id: body.usuario?.id || null,
                tienda_id: body.usuario?.tienda_id || null,
                producto_id: item.producto_id,
                cantidad: item.cantidad,
                precio_costo: item.precio_costo,
                unidades_regalo: item.unidades_regalo || 0,
                origen: 'voz',
              });
            }
          } else if (accion?.tipo === 'editar') {
            for (const ed of accion.ediciones) {
              if (ed.eliminar) {
                await ajustarStock({ producto_id: ed.producto_id, desactivar: true });
              } else {
                await editarProducto({ producto_id: ed.producto_id, campos: ed.campos });
              }
            }
          } else if (accion?.tipo === 'anular') {
            const r = await anularUltimaVenta({ tienda_id: body.usuario?.tienda_id });
            if (!r.ok) return res.status(200).json({ respuesta: r.error || 'No se pudo anular' });
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
    console.error('[Dona API ERROR]', { timestamp: new Date().toISOString(), error: err.message, stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
};
