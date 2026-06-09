# Dona — Detalles del Proyecto

## ¿Qué es Dona?
SaaS PWA para pequeñas bodegas peruanas. Permite gestionar inventario, ventas, fiados y análisis de facturas de proveedores mediante inteligencia artificial (voz + imagen). Diseñada para bodegueros con poco tiempo y sin experiencia tecnológica.

---

## Stack técnico
| Capa | Tecnología |
|---|---|
| Frontend | HTML + CSS + JS vanilla (PWA) |
| Backend | Vercel serverless (`module.exports`) |
| Base de datos | Supabase (PostgreSQL) |
| IA | Claude Haiku (visión + chat) vía Anthropic API |
| Distribución móvil | PWA instalable / Play Store via TWA (PWABuilder) |

---

## Arquitectura de la app

### Pantallas principales
```
Login (2 pasos)
    └── App principal
            ├── Chat IA (voz + texto)
            ├── Ventas
            ├── Inventario (lista de productos)
            └── Fiados
```

### Login — Flujo de 2 pasos (Opción C)

**Paso 1 — Identificar la bodega**
- El usuario escribe el **código de su bodega** (ej: `losreyes`) y presiona Buscar
- La app consulta `getUsuariosBodega` → busca la tienda activa con ese código
- Si la encuentra: muestra el nombre de la bodega y avanza al paso 2
- Si no la encuentra: muestra error *"Código no encontrado. Verifica con tu encargado."*

**Paso 2 — Identificarse y entrar**
- Aparece un **dropdown con todos los usuarios activos** de esa bodega (admins + vendedores)
- El usuario selecciona su nombre → escribe su contraseña → presiona Ingresar
- Un enlace **"Cambiar"** permite volver al paso 1 si se equivocó de bodega

**Comportamiento del dropdown**
- Muestra a **todos los roles** por igual (admin y vendedor)
- Si un vendedor es desactivado por el admin → desaparece del dropdown automáticamente
- El código de bodega es **compartido** entre todo el personal (no es secreto)
- La contraseña es **individual** de cada usuario

```
Bodega "losreyes" → dropdown muestra:
  • María  (admin)
  • Juan   (vendedor)
  • Rosa   (vendedor)
```

**Al cerrar sesión:** la app limpia los campos y regresa al paso 1 automáticamente.

### Panel Superadmin (`/admin`)
- Dashboard global con métricas de todas las bodegas
- Catálogo Global de productos (alimentado con escáner de código de barras)
- Gestión de tiendas (activar / desactivar / eliminar)

---

## Modelo de datos (Supabase)

### Tablas principales
| Tabla | Descripción |
|---|---|
| `tiendas` | Cada bodega registrada. Campos: `id`, `nombre`, `codigo`, `propietario`, `ciudad`, `whatsapp`, `plan`, `activo` |
| `usuarios` | Personal de cada bodega. Campos: `id`, `tienda_id`, `username`, `nombre`, `rol` (admin/vendedor), `activo` |
| `productos` | Catálogo por tienda. Campos: `id`, `tienda_id`, `nombre`, `stock`, `precio_venta`, `precio_costo`, `unidad`, `stock_minimo`, `activo` |
| `ventas` | Registro de ventas. Campos: `tienda_id`, `total`, `origen` (ia/manual), `es_fiado`, `metodo_pago`, `cliente_nombre` |
| `detalle_ventas` | Líneas de cada venta |
| `entradas_mercaderia` | Registro de compras a proveedores (facturas escaneadas) |
| `facturas_registradas` | Facturas analizadas por IA |
| `catalogo_global` | Catálogo compartido entre todas las bodegas. Campos: `codigo_barras`, `nombre`, `marca`, `categoria`, `unidad` |

---

## Funcionalidades implementadas

### Chat IA (voz + texto)
- Responde preguntas sobre el inventario
- Registra ventas por voz
- Edita productos (stock, precio, stock mínimo) por voz
- Muestra reportes y tablas
- Soporta comandos en español natural peruano

### Análisis de facturas (OCR con Claude Vision)
- Fotografía → extrae productos, cantidades y precios
- Algoritmo de 4 pasos (PASO 1–4) para calcular precio costo unitario real
- Maneja IGV 18%, ISC, PERCEPCIÓN, RETENCIÓN
- **Solo facturas peruanas**
- Al escanear una factura: crea productos nuevos + actualiza stock + registra precio de costo

### Inventario
- Lista de productos con stock, precio y stock mínimo
- Edición individual por producto
- Alertas de stock bajo (stock < stock_mínimo)
- Stock mínimo editable por voz IA
- **"Ver más detalles"** en cada producto (expandible): muestra historial de los últimos 5 ingresos con fecha, cantidad, precio costo por entrada, proveedor, número de factura y origen (factura/manual)
  - El precio costo del formulario muestra el valor **actual** del producto
  - El precio costo del historial muestra el valor **en cada entrada específica** — permite ver evolución de precios y comparar costos entre proveedores si la bodega cambió de proveedor

### Catálogo Global (Superadmin)
- Escáner de código de barras (html5-qrcode, EAN-13)
- El superadmin agrega productos al catálogo global
- Avisa si el producto ya está registrado
- Las bodegas pueden consultar el catálogo al agregar productos

### PWA
- Instalable en Android/iOS desde el navegador
- Funciona offline (assets cacheados)
- Service Worker con versión `bodega-v5`
- Íconos PNG 192x512 (requerido por Chrome)
- Distribución en Play Store via TWA (pendiente piloto)

---

## Los tres flujos de gestión de productos

Es importante distinguir tres flujos que se confunden fácilmente pero son completamente distintos:

| Flujo | ¿Qué hace? | ¿Cuándo se usa? | Estado |
|---|---|---|---|
| **Registro inicial** | Crea los productos en el sistema por primera vez | Solo una vez, al arrancar | Por construir (modo escáner) |
| **Conteo físico** | Corrige el stock de productos que ya existen | Periódicamente (semanal/mensual) | Por construir (modo inventario) |
| **Escaneo de facturas** | Crea productos Y actualiza stock desde una factura | Cada vez que llega mercadería | Implementado ✅ |

> **Regla clave:** el Conteo físico requiere que los productos ya existan. Sin Registro inicial no hay nada que contar.

---

## Flujo de onboarding según situación de la bodega

### Caso A — La bodega tiene facturas de proveedores (situación ideal)
```
1. La bodega se registra en la app
         ↓
2. Reúne sus últimas 3-5 facturas de proveedores
         ↓
3. Las escanea una por una con la cámara
   → Los productos se crean automáticamente
   → El stock inicial se carga desde la factura
   → Se registra el precio de costo
         ↓
4. Hace un conteo físico rápido para corregir
   diferencias entre factura y stock real
         ↓
5. Listo para el día a día
```

### Caso B — La bodega NO tiene facturas (compra en mercado sin comprobante)
```
1. La bodega se registra en la app
         ↓
2. Usa el Modo Carga Inicial (por construir)
   → Recorre la bodega con el celular
   → Escanea el código de barras de cada producto
   → La app busca el nombre en el Catálogo Global
   → El bodeguero confirma nombre, escribe precio
     y cantidad que tiene físicamente en ese momento
   → Guarda → producto creado con stock inicial
   → Repite con el siguiente producto
         ↓
3. Listo para el día a día
```

> El **Modo Carga Inicial** en realidad no requiere una pantalla especial — agregar productos de a uno (sección Inventario) o escaneando facturas ya cubre esta necesidad. No es prioritario construirlo como flujo separado.

---

## Flujo de inventario físico periódico (Conteo físico)

Para bodegas que **ya tienen productos registrados** y quieren verificar que el stock del sistema coincide con la realidad física:

Para el target de Dona (bodegas pequeñas, 30-60 productos), las herramientas actuales son suficientes:

| Método | Cómo se usa |
|---|---|
| **Voz IA** | *"el aceite quedó en 8, el arroz en 15, el azúcar en 1"* — varios de golpe en un mensaje |
| **Sección Inventario** | Editar cada producto individualmente de forma visual |

> **Decisión de producto:** no se construirá un Modo Conteo Físico separado. Agregar más pantallas y flujos especiales aumenta la complejidad de una app pensada para usuarios no técnicos. Las herramientas existentes cubren bien esta necesidad para el tamaño de bodega que es el target.

### Tip: conteo en equipo por orden alfabético
La lista de productos en la app aparece en orden alfabético. Si la bodega tiene varios vendedores, pueden dividirse el conteo:

```
Vendedor 1 → productos A hasta M
Vendedor 2 → productos N hasta Z
```

Cada uno entra con su propio usuario, recorre su sección y actualiza por voz IA. Lo que solo tardaría 30 minutos, en equipo se hace en 10. No requiere ninguna coordinación especial — cada uno actualiza productos distintos, no hay conflicto.

---

## Resumen del árbol de decisión para una bodega nueva

```
¿Tiene facturas de proveedores?
    ├── SÍ → Escanear facturas → productos + stock automático
    │                  ↓
    │         Conteo físico para corregir diferencias
    │
    └── NO → Modo Carga Inicial (escanear producto por producto)
                       ↓
              Bodega tiene productos registrados con stock real
                       ↓
              Conteo Físico periódico para mantener exactitud
```

---

## Matching de productos en facturas

### El problema
Cuando Claude analiza una factura, intenta hacer match entre el nombre del producto en la factura y los productos existentes en el inventario. Si los nombres son muy distintos puede fallar:

```
Inventario:  "Coca Cola 500ml"
Factura:     "BEB. GASEOSA COCA COLA DESC. 500ML"
             → Claude no está seguro → riesgo de duplicado
```

### Solución elegida: Opción C — Preguntarle al bodeguero en el momento

Cuando Claude no está seguro del match, en lugar de decidir solo, muestra una pregunta simple al bodeguero justo después de escanear la factura:

```
⚠️ Encontré este producto en la factura:
"BEB. GASEOSA COCA COLA 500ML"

¿Es el mismo que tienes como "Coca Cola 500ml"?

[ ✅ Sí, es el mismo ]  [ ❌ No, es diferente ]
```

- El bodeguero conoce su mercadería mejor que nadie
- Resuelve el problema en el momento sin esperar
- No crea duplicados ni requiere correcciones posteriores

### Sistema de aprendizaje en superadmin (futuro)
A largo plazo, todas las confirmaciones del bodeguero (sí/no) se guardan como reglas de equivalencia. En el superadmin habrá una sección donde se pueden revisar y aplicar estas reglas a todas las bodegas — así si "BEB. GASEOSA COCA COLA 500ML" fue confirmado como "Coca Cola 500ml" en una bodega, el sistema lo sabe para todas las demás.

**Estado:** pendiente de implementar (post piloto)

---

## Sistema de precios y planes (pendiente piloto)

| Plan | Target | Precio estimado |
|---|---|---|
| Básico | Bodegas pequeñas | Por definir |
| Pro | Bodegas con más movimiento | Por definir |

- Integración de pagos: **Culqi** (pasarela peruana)
- Límites de uso de IA por plan (post-piloto)

---

## Tareas pendientes

### Corto plazo (antes del piloto)
- [ ] Configurar `ADMIN_SECRET` en Vercel dashboard
- [ ] Activar límite de gasto Anthropic ($30/mes)
- [ ] Probar login de 2 pasos con bodega real

### Mediano plazo (durante piloto)
- [ ] Crear manual físico del usuario — tarjeta A5 laminada (Task #1)
- [ ] Llevar el escáner de código de barras del superadmin a la app del bodeguero
- [ ] Implementar pregunta al bodeguero cuando Claude no está seguro del match en facturas (Opción C)
- [ ] Límites de uso de IA por plan

### Largo plazo (post-piloto)
- [ ] Sistema de aprendizaje de equivalencias de nombres en superadmin (revisar y aplicar reglas globales de matching)

### Largo plazo (post-piloto)
- [ ] Integración Culqi + planes de pago
- [ ] Distribución en Play Store via TWA/PWABuilder
- [ ] Análisis más avanzado de márgenes y rentabilidad

---

## Reglas del proyecto

- **Solo facturas peruanas** — no agregar lógica para facturas de otros países
- `server.py` y `test.py` nunca se modifican
- `api/chat.js` es la versión Vercel (`module.exports = async (req, res)`)
- Siempre correr `node --check` antes de entregar cambios en archivos `.js`
- Cuando se modifica `chat.js`, mantener sincronizada la versión Netlify

---

## Notas técnicas relevantes

- **Brillo automático en fotos de facturas:** si la luminancia promedio < 110, se aplica boost de contraste antes de enviar a Claude Vision
- **Tablas en el chat:** se limpian espacios antes/después server-side en `api/chat.js` para evitar gaps visuales
- **EAN-13:** el primer dígito impreso a la izquierda de las barras SÍ forma parte del código (13 dígitos en total)
- **Service Worker:** versión `bodega-v7`, nunca cachea llamadas a `/api/`, `/admin`, ni recursos externos

---

## Seguridad (OWASP Top 10 — auditoría completa)

Auditoría realizada en junio 2026 sobre `api/chat.js` (Vercel), `netlify/functions/chat.js` e `index.html`. Todas las categorías aplicables fueron corregidas.

### Variables de entorno requeridas en Vercel
| Variable | Cómo generarla | Para qué |
|---|---|---|
| `TOKEN_SECRET` | `openssl rand -hex 32` | Firma HMAC-SHA256 de tokens de sesión |
| `ALLOWED_ORIGIN` | URL exacta del deployment (ej: `https://bodega-don-pepe.vercel.app`) | Restringe CORS al dominio propio — debe incluir `https://` sin barra final |
| `SUPABASE_SERVICE_KEY` | Panel Supabase → Settings → API | Clave de servicio (eliminado el fallback a la anon key hardcodeada) |

### Modelo de autenticación post-login
- Login devuelve un **token HMAC-SHA256** con payload `{ user_id, tienda_id, rol, nombre, exp }` y TTL de 24 h
- El frontend guarda el token en `estadoApp.token` (memoria, no localStorage) y lo envía en cada petición
- El servidor **sobrescribe** `tienda_id`, `usuario_id` y `solicitante_rol` del body con los valores del token verificado — el cliente no puede falsificarlos
- Sesión expirada → respuesta `{ sesion_invalida: true }` → frontend llama `cerrarSesion()` automáticamente
- Acciones públicas (`auth`, `getUsuariosBodega`, `registro`, `ping`) no requieren token — todo lo demás sí

### OWASP Top 10 — resultado por categoría

| # | Categoría | Estado | Qué se hizo |
|---|---|---|---|
| A01 | Broken Access Control | ✅ PASA | `desactivarVendedor` y `cambiarPassword` verifican que el target pertenezca a la misma `tienda_id`. El servidor extrae `tienda_id` y `rol` del token — el cliente no puede pasarlos en el body |
| A02 | Cryptographic Failures | ✅ PASA | Eliminada `SUPABASE_ANON_KEY` hardcodeada. Tokens HMAC-SHA256 firmados con `TOKEN_SECRET`. Comparación de firmas con `crypto.timingSafeEqual` (evita timing attacks) |
| A03 | Injection / XSS | ✅ PASA | Sanitizador HTML con lista blanca (`sanitizarHtml`) en todo lo que va al chat. `mensaje_duplicado` usa `textContent`. Botones dinámicos con `addEventListener` en vez de `onclick` inline con datos del servidor |
| A04 | Insecure Design | ✅ PASA | Separación clara entre acciones públicas y protegidas. El handler central verifica token antes de ejecutar cualquier acción privada. `tienda_id` nunca sale del token |
| A05 | Security Misconfiguration | ✅ PASA | CORS restringido a `ALLOWED_ORIGIN`. Errores del servidor devuelven mensaje genérico sin stack trace ni detalles internos |
| A06 | Vulnerable Components | ✅ NO APLICA | Frontend vanilla JS sin dependencias npm. Backend usa solo módulos nativos de Node.js (`crypto`, `https`) |
| A07 | Identification & Auth Failures | ✅ PASA | Rate limiting 5 intentos / 15 min por username (in-memory). Mensajes de error genéricos que no revelan si el usuario existe. Sesión con TTL de 24 h |
| A08 | Software & Data Integrity | ✅ PASA | Sin deserialización de objetos no confiables. Dependencias mínimas y fijas. No hay eval ni Function() con datos de usuario |
| A09 | Logging & Monitoring | ✅ PASA | `logSecurity()` registra: intentos fallidos de login (`AUTH_FAILURE`), rate limit alcanzado (`RATE_LIMIT_HIT`), tokens inválidos (`INVALID_TOKEN`), cambios de contraseña por admin, `TOKEN_SECRET` ausente |
| A10 | SSRF | ✅ NO APLICA | El servidor solo hace fetch a URLs fijas (Supabase, Anthropic). No hay ningún endpoint que acepte URLs del cliente |

### Archivos modificados en la auditoría
- `api/chat.js` — token HMAC, rate limiting, IDOR fixes, CORS, logging
- `netlify/functions/chat.js` — sincronizado con los mismos controles
- `index.html` — sanitizador HTML, token en `estadoApp`, manejo de `sesion_invalida`, fix XSS en botones dinámicos
- `sw.js` — bump a `bodega-v7` para forzar actualización del cache
