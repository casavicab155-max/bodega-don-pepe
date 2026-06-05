// =============================================
// Dona — Panel Superadmin
// Solo accesible con ADMIN_SECRET correcto
// =============================================

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://eoyvzkargirskdttuxmn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVveXZ6a2FyZ2lyc2tkdHR1eG1uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0OTQyNzIsImV4cCI6MjA5NTA3MDI3Mn0.k3Znq41STrhcpVW-9ETvtojN6qZqEsovV-VC_Nxox6I';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'dona2026admin';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

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
    throw new Error(`Supabase ${res.status}: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function fechaHoy() {
  return new Date().toISOString().split('T')[0];
}
function fechaHace(dias) {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  return d.toISOString().split('T')[0];
}
function inicioMes() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

async function getDashboard() {
  const hoy = fechaHoy();
  const inicioMesStr = inicioMes();
  const hace7 = fechaHace(7);

  const hace14 = fechaHace(14);

  // Datos base en paralelo
  const [tiendas, usuarios, todasVentas, todosProductos, todosFiados, ventasSemanaAnterior] = await Promise.all([
    sb('GET', 'tiendas?order=created_at.desc'),
    sb('GET', 'usuarios?activo=eq.true&order=created_at.desc'),
    sb('GET', `ventas?order=created_at.desc&created_at=gte.${inicioMesStr}`),
    sb('GET', 'productos?activo=eq.true'),
    sb('GET', 'ventas?es_fiado=eq.true&order=created_at.desc'),
    sb('GET', `ventas?created_at=gte.${hace14}&created_at=lte.${hace7}`),
  ]);

  // ── Métricas globales ────────────────────────────────────────────
  const ventasHoy = todasVentas.filter(v => v.created_at.startsWith(hoy));
  const ventasSemana = todasVentas.filter(v => v.created_at >= hace7);
  const ventasMes = todasVentas;

  const totalVentasHoy = ventasHoy.reduce((s, v) => s + parseFloat(v.total || 0), 0);
  const totalVentasSemana = ventasSemana.reduce((s, v) => s + parseFloat(v.total || 0), 0);
  const totalVentasMes = ventasMes.reduce((s, v) => s + parseFloat(v.total || 0), 0);

  const consultasIAHoy = ventasHoy.filter(v => v.origen === 'ia').length;
  const consultasIASemana = ventasSemana.filter(v => v.origen === 'ia').length;
  const consultasIAMes = ventasMes.filter(v => v.origen === 'ia').length;

  const fiadosPendientes = todosFiados.filter(v => {
    const pagado = parseFloat(v.monto_pagado || 0);
    const total = parseFloat(v.total || 0);
    return pagado < total;
  });
  const totalFiados = fiadosPendientes.reduce((s, v) =>
    s + parseFloat(v.total || 0) - parseFloat(v.monto_pagado || 0), 0);

  // ── Métricas por tienda ──────────────────────────────────────────
  const tiendaStats = tiendas.map(t => {
    const ventasTienda = todasVentas.filter(v => v.tienda_id === t.id);
    const ventasTiendaHoy = ventasTienda.filter(v => v.created_at.startsWith(hoy));
    const productosTienda = todosProductos.filter(p => p.tienda_id === t.id);
    const productosConStock = productosTienda.filter(p => parseFloat(p.stock || 0) > 0);
    const usuariosTienda = usuarios.filter(u => u.tienda_id === t.id);
    const fiadosTienda = fiadosPendientes.filter(v => v.tienda_id === t.id);

    const montoMes = ventasTienda.reduce((s, v) => s + parseFloat(v.total || 0), 0);
    const montoHoy = ventasTiendaHoy.reduce((s, v) => s + parseFloat(v.total || 0), 0);
    const iaUsoMes = ventasTienda.filter(v => v.origen === 'ia').length;
    const fiadoDeuda = fiadosTienda.reduce((s, v) =>
      s + parseFloat(v.total || 0) - parseFloat(v.monto_pagado || 0), 0);

    // Días activos este mes (días distintos con al menos 1 venta)
    const diasActivos = new Set(ventasTienda.map(v => v.created_at.slice(0, 10))).size;

    // Crecimiento: ventas esta semana vs semana anterior
    const ventasSemanaT = todasVentas.filter(v => v.tienda_id === t.id && v.created_at >= hace7);
    const ventasSemAntT = ventasSemanaAnterior.filter(v => v.tienda_id === t.id);
    const montoSemana = ventasSemanaT.reduce((s, v) => s + parseFloat(v.total || 0), 0);
    const montoSemAnt = ventasSemAntT.reduce((s, v) => s + parseFloat(v.total || 0), 0);
    const crecimiento = montoSemAnt > 0
      ? Math.round(((montoSemana - montoSemAnt) / montoSemAnt) * 100)
      : montoSemana > 0 ? 100 : 0;

    const ultimaActividad = ventasTienda[0]?.created_at || null;
    const diasSinActividad = ultimaActividad
      ? Math.floor((Date.now() - new Date(ultimaActividad)) / 86400000)
      : null;

    return {
      id: t.id,
      nombre: t.nombre,
      propietario: t.propietario,
      codigo: t.codigo || '',
      plan: t.plan || 'basico',
      ciudad: t.ciudad || null,
      whatsapp: t.whatsapp || null,
      creado: t.created_at,
      ventasMes: ventasTienda.length,
      montoMes: montoMes.toFixed(2),
      ventasHoy: ventasTiendaHoy.length,
      montoHoy: montoHoy.toFixed(2),
      iaUsoMes,
      diasActivos,
      crecimiento,
      montoSemana: montoSemana.toFixed(2),
      productos: productosTienda.length,
      productosConStock: productosConStock.length,
      vendedores: usuariosTienda.filter(u => u.rol === 'vendedor').length,
      fiadoDeuda: fiadoDeuda.toFixed(2),
      ultimaActividad,
      diasSinActividad,
      activa: diasSinActividad !== null && diasSinActividad <= 7,
    };
  });

  // ── Actividad reciente (últimas 30 ops de todas las tiendas) ─────
  const actividadReciente = todasVentas.slice(0, 30).map(v => {
    const tienda = tiendas.find(t => t.id === v.tienda_id);
    return {
      tienda: tienda?.nombre || 'Desconocida',
      total: parseFloat(v.total || 0).toFixed(2),
      origen: v.origen,
      es_fiado: v.es_fiado,
      metodo_pago: v.metodo_pago,
      cliente: v.cliente_nombre,
      fecha: v.created_at,
    };
  });

  // ── Uso de features ──────────────────────────────────────────────
  const features = {
    ventasIA: ventasMes.filter(v => v.origen === 'ia').length,
    ventasManuales: ventasMes.filter(v => v.origen === 'manual').length,
    fiados: ventasMes.filter(v => v.es_fiado).length,
  };

  return {
    global: {
      tiendas: tiendas.length,
      usuarios: usuarios.length,
      vendedores: usuarios.filter(u => u.rol === 'vendedor').length,
      productos: todosProductos.length,
      totalVentasHoy: totalVentasHoy.toFixed(2),
      totalVentasSemana: totalVentasSemana.toFixed(2),
      totalVentasMes: totalVentasMes.toFixed(2),
      cantVentasHoy: ventasHoy.length,
      cantVentasSemana: ventasSemana.length,
      cantVentasMes: ventasMes.length,
      consultasIAHoy,
      consultasIASemana,
      consultasIAMes,
      totalFiados: totalFiados.toFixed(2),
      catalogoGlobal: (await sb('GET', 'catalogo_global?select=codigo_barras').catch(() => [])).length,
    },
    tiendas: tiendaStats,
    actividadReciente,
    features,
  };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    return res.status(200).setHeader('Access-Control-Allow-Origin', '*').end();
  }

  try {
    const body = req.method === 'POST' ? req.body : {};
    const { secret, action } = typeof body === 'string' ? JSON.parse(body) : body;

    if (secret !== ADMIN_SECRET) {
      return res.status(401).json({ ok: false, error: 'No autorizado' });
    }

    if (action === 'dashboard') {
      const data = await getDashboard();
      return res.status(200).json({ ok: true, ...data });
    }

    if (action === 'desactivarTienda') {
      const { tienda_id } = body;
      if (!tienda_id) return res.status(400).json({ ok: false, error: 'Falta tienda_id' });
      // Desactivar tienda y todos sus usuarios
      await sb('PATCH', `tiendas?id=eq.${tienda_id}`, { activo: false });
      await sb('PATCH', `usuarios?tienda_id=eq.${tienda_id}`, { activo: false });
      return res.status(200).json({ ok: true });
    }

    if (action === 'reactivarTienda') {
      const { tienda_id } = body;
      if (!tienda_id) return res.status(400).json({ ok: false, error: 'Falta tienda_id' });
      await sb('PATCH', `tiendas?id=eq.${tienda_id}`, { activo: true });
      await sb('PATCH', `usuarios?tienda_id=eq.${tienda_id}`, { activo: true });
      return res.status(200).json({ ok: true });
    }

    if (action === 'eliminarTienda') {
      const { tienda_id } = body;
      if (!tienda_id) return res.status(400).json({ ok: false, error: 'Falta tienda_id' });
      // Borrado en orden correcto (respetando foreign keys)
      const ventas = await sb('GET', `ventas?tienda_id=eq.${tienda_id}&select=id`);
      if (ventas && ventas.length > 0) {
        const ids = ventas.map(v => v.id);
        for (const id of ids) {
          await sb('DELETE', `detalle_ventas?venta_id=eq.${id}`).catch(() => {});
        }
      }
      await sb('DELETE', `ventas?tienda_id=eq.${tienda_id}`).catch(() => {});
      await sb('DELETE', `entradas_mercaderia?tienda_id=eq.${tienda_id}`).catch(() => {});
      await sb('DELETE', `facturas_registradas?tienda_id=eq.${tienda_id}`).catch(() => {});
      await sb('DELETE', `productos?tienda_id=eq.${tienda_id}`).catch(() => {});
      await sb('DELETE', `usuarios?tienda_id=eq.${tienda_id}`).catch(() => {});
      await sb('DELETE', `tiendas?id=eq.${tienda_id}`).catch(() => {});
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Acción no reconocida' });
  } catch (e) {
    console.error('Admin error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
