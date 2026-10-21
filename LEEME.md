# Repuestos Core OS: publicación en Vercel con base de datos

Versión 2 de la sincronización, pensada para un taller con hasta ~10 equipos
trabajando a la vez.

## Archivos
- `index.html`: el sistema.
- `manifest.webmanifest`, `sw.js` e `icons/`: hacen que se pueda instalar como app
  y que abra sin internet.
- `api/sync.js`: la función de Vercel que guarda y reparte los cambios.
- `vercel.json`: ubica la función en São Paulo (gru1), cerca de Misiones.
- `package.json`: no necesita dependencias.

**Si ya habías subido la versión anterior:** borrá `api/state.js` del repositorio.
Los datos que ya estaban cargados se pasan solos al formato nuevo la primera vez que
alguien entra.

## Pasos (una sola vez)
1. Subí esta carpeta a GitHub e importala en Vercel (Add New → Project, Framework: Other).
2. **Storage → Create Database → Upstash for Redis** (plan Free). Elegí la región
   **São Paulo** y conectala al proyecto.
3. **Settings → Environment Variables:** `APP_PIN` = clave del taller (8 caracteres o más).
4. **Redeploy**.

## Instalar la app en cada equipo
Una vez publicado en Vercel (con https):
- **PC (Chrome o Edge):** el botón **"Instalar app"** del sistema, o el ícono de instalar
  en la barra de direcciones. Queda en el escritorio y en el menú Inicio.
- **Android (Chrome):** el botón **"Instalar app"**, o el menú ⋮ → "Instalar app".
- **iPhone o iPad (Safari):** Compartir → "Agregar a inicio".

Se abre en su propia ventana, sin barra del navegador. Si se corta internet, abre igual
y sube los cambios cuando vuelve la conexión. Al mantener apretado el ícono aparecen
accesos directos a Vender, Stock y Caja.

**Para publicar una versión nueva:** cambiá `VERSION` al principio de `sw.js` (por
ejemplo, de `rcos-2.1.0` a `rcos-2.1.1`). Así todos los equipos bajan la actualización
solos, y se ve la próxima vez que abren la app.

## Qué cambió para que aguante muchas operaciones a la vez
- **Cada registro se guarda por separado.** Cada equipo sube y baja solo lo que cambió,
  no el sistema entero.
- **Cambios campo por campo.** Si un equipo cambia el costo de un repuesto y otro lo
  vende al mismo tiempo, se guardan las dos cosas.
- **Stock con reserva atómica.** Antes de cobrar, el servidor verifica y descuenta el
  stock en un solo paso. Si otro equipo se llevó las últimas unidades, la venta se frena
  con un aviso. El stock no queda negativo, salvo ventas hechas sin internet.
- **Números de ticket asignados por el servidor.** No se repiten aunque varios equipos
  vendan en el mismo segundo.
- **Historial por mes.** Al abrir, cada equipo baja solo los últimos 4 meses. Los meses
  anteriores se traen con "Traer [mes]" en Ventas hechas o en Libro IVA.
- **Consultas que se adaptan al uso.** Cada 5 segundos si el equipo está en uso, cada
  30 si está quieto, y casi nada si la pestaña está en segundo plano. Cada consulta sin
  cambios gasta 1 operación de la base.
- **Sin internet sigue andando.** Los cambios se suben cuando vuelve la conexión.
- **Límites de seguridad.** 240 pedidos por minuto por conexión, registros de 64 KB como
  máximo y bloqueo de 15 minutos tras 10 claves incorrectas.

## Pruebas realizadas (con una base Redis simulada)
- 10 equipos vendiendo el mismo repuesto a la vez: stock correcto en todos y tickets
  del 1 al 10 sin repetir.
- 50 intentos de venta sobre 35 unidades: salieron 35, el stock quedó en 0 y las otras
  15 se frenaron con aviso.
- Cambio de costo y venta simultáneos sobre el mismo repuesto: se conservaron los dos.
- Venta sin internet: se sincronizó al volver, con número corregido si hacía falta.

## Costos de Upstash
El plan gratis incluye 500.000 operaciones por mes. Una venta gasta unas 14
operaciones y una consulta sin cambios, 1. Con 10 equipos en uso todo el día puede
pasarse del plan gratis. El plan por uso cuesta poco, pero conviene revisar el panel
de Upstash el primer mes.

## Si en el futuro crece más
Para varias sucursales o venderlo a otros talleres, el paso siguiente es Postgres con
tablas (Neon o Supabase), usuarios con contraseña propia y factura electrónica real
con ARCA.
