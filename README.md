# ERP Distribuidora Lila — Documentación técnica

> Propósito de este documento: que cualquier programador (o asistente de IA)
> pueda entender, mantener y continuar este sistema sin ayuda de quien lo hizo.
> Última actualización: 18/07/2026 — versión app 20260718-02.

## Qué es

Sistema de gestión interno de Distribuidora Lila (distribuidora de alimentos,
Argentina). Cubre: clientes, pedidos, remitos, cobranzas, hoja de ruta de
reparto, zonas, listas de precios, gastos, contabilidad simple (mayor, estado
de resultado), resultado mensual gerencial e importación de datos históricos
desde el sistema de facturación FoxPro (que sigue siendo el sistema fiscal).

## Arquitectura (deliberadamente simple)

- **Un solo archivo `index.html`** con todo: HTML + CSS + JavaScript vanilla.
  Sin frameworks, sin build, sin npm. Se edita con cualquier editor de texto.
- **Base de datos: Supabase** (PostgreSQL administrado). La app consulta
  directo con `supabase-js` desde el navegador.
- **Hosting: GitHub Pages** del repo `alexisscopetta2026/lila-distribuidora`.
  Subir un archivo al repo = deploy (tarda 1-3 minutos).
- **PWA**: `manifest.json` + `sw.js` (service worker, cache network-first).
  Al cambiar `index.html` hay que subir la versión en DOS lugares:
  `APP_VERSION` en index.html y `CACHE_VERSION` en sw.js (formato AAAAMMDD-NN).

## Acceso a los datos

- Proyecto Supabase: `ixniwmrjawlbpksdmbfo.supabase.co` (cuenta del dueño).
- La clave que figura en el código (`sb_publishable_...`) es la clave PÚBLICA,
  está bien que esté visible. La clave secreta (service_role) NUNCA va en el
  código y nunca estuvo.
- Autenticación: Supabase Auth con 6 usuarios (emails `usuario@lila.local`).
  El mapeo usuario→rol está en la constante `USUARIOS` de index.html.
  Roles: vendedor / repartidor / admin (esAdmin, rol_original).
- Seguridad de datos: RLS (Row Level Security) en todas las tablas con
  política "solo usuarios logueados" (rol authenticated), anon revocado.
  Ver `bloqueo_rls.sql`.

## Tablas principales (schema public)

Operativas: clientes, pedidos, remitos, cobros, productos, zonas, hoja_ruta,
cargas, listas_precios, lista_precios_items, proveedores, comprobantes_compras,
pagos_proveedores, notas_credito, movimientos_bancarios, vendedores.
Contables: gastos, asientos, asientos_detalle.
Gerenciales: resultado_mensual, resultado_mensual_gastos (pantalla
Contabilidad→Mensual: ventas y contribución marginal mensuales del FoxPro,
gastos por rubro, caja ingresó/salió).
Históricas importadas del FoxPro: importaciones_ventas (ranking de ventas por
cliente por mes), importaciones_saldos, importaciones_resultado, y el respaldo
importaciones_ventas_respaldo (1.931 filas, NO borrar).
Convención de períodos: SIEMPRE "MM-AAAA" (ej: 02-2026). La función
`normalizarPeriodo()` en index.html convierte cualquier variante.

## Flujo de datos con FoxPro

FoxPro factura; una vez por mes se exporta el "Ranking de cantidades vendidas"
(columnas Código | Descripción | Cpra Total, datos desde la fila 6) y se
importa por la app en Configuración/Importar histórico. El importador valida
que sea un ranking de clientes, normaliza el período y PISA el mes si ya
existe. Controles de validación conocidos: el total importado debe coincidir
con el control del FoxPro (~1-2% de tolerancia por descuentos). El ranking es
NETO (resta notas de crédito) e incluye todos los tipos de comprobante; los
reportes de FoxPro filtrados por un solo tipo (ej. solo presupuestos) NO
sirven como fuente.

## Cómo hacer un cambio

1. Descargar `index.html` del repo (o clonarlo).
2. Editar. El código está organizado por secciones con comentarios
   `<!-- SECCIÓN X -->` y `// ═══ NOMBRE ═══`.
3. Subir `APP_VERSION` (index.html) y `CACHE_VERSION` (sw.js).
4. Subir al repo por la web de GitHub (Add file → Upload) o git push.
5. Los celulares toman la versión nueva al reabrir la app con conexión.

## Copias de seguridad (IMPORTANTE)

Los datos viven solo en Supabase. Hacer backup periódico:
- Manual: Supabase → Database → Backups (plan gratuito: diario, 7 días), y/o
- Exportar a CSV: SQL Editor → `SELECT * FROM tabla` → Download CSV, o
  Table Editor → Export. Recomendado: exportar todas las tablas 1 vez por mes
  y guardar en un pendrive/Drive de la empresa.

## Historial de decisiones relevantes

- 2026-07-16: importador normaliza períodos y valida tipo de archivo (antes
  hubo 9 etiquetas para 6 meses y un ranking de productos importado como
  clientes; se limpió por SQL con respaldo).
- 2026-07-16/18: migración de login local hardcodeado a Supabase Auth + RLS
  en todas las tablas (antes la base estaba abierta al rol anon).
- 2026-07-18: estilo "alto contraste" global (texto negro, tablas con
  cuadrícula) por pedido del dueño; pantalla Resultado Mensual con manejo por
  teclado (Enter avanza, Insert agrega gasto, F10/Ctrl+Enter guarda).

## Contacto de contexto

Dueños/operación: Mauricio (admin) y Alexis (admin técnico). El sistema se
desarrolló iterativamente con asistencia de IA (Claude, de Anthropic); ante
dudas sobre el código, cualquier sesión de Claude u otro asistente puede
analizarlo leyendo este archivo y el index.html — está escrito para eso.
