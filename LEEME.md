# Repuestos Core OS: cómo publicarlo con base de datos en Vercel

Con estos archivos el sistema guarda todo en una base de datos y los cambios se ven
en todas las computadoras y celulares del taller en pocos segundos.

## Archivos
- `index.html`: el sistema.
- `api/state.js`: la función de Vercel que lee y guarda los datos.
- `package.json`: dependencias (Upstash Redis).

## Pasos (una sola vez)
1. Subí esta carpeta a un repositorio de GitHub e importalo en Vercel (Add New → Project).
   Framework: **Other**. No hace falta comando de build.
2. En el proyecto de Vercel: **Storage → Create Database → Upstash for Redis** (plan Free)
   y conectala al proyecto. Vercel agrega solo las variables de conexión.
3. En **Settings → Environment Variables** creá `APP_PIN` con la clave del taller
   (usá una de 8 caracteres o más, no "1234").
4. **Redeploy** para que tome la clave.
5. Abrí el sitio, ingresá la clave y elegí con qué empezar: vacío, datos de ejemplo
   o lo que ya tenías cargado en esa computadora.

## Cómo funciona
- Cada cambio se guarda en la base en menos de un segundo. Los otros dispositivos lo
  ven en unos 8 segundos (o al volver a la pestaña).
- Si se corta internet, el dispositivo sigue andando y sube los cambios cuando vuelve.
- Si dos dispositivos venden el mismo repuesto a la vez, el stock se descuenta bien
  en los dos casos.
- La clave se pide una vez por dispositivo. Después de 10 intentos fallidos desde la
  misma conexión, se bloquea 15 minutos.

## Límites del plan gratis de Upstash
500.000 operaciones y 256 MB por mes. Con 2 o 3 dispositivos abiertos todo el día
alcanza. Si quedan muchos dispositivos abiertos las 24 horas, conviene cerrarlos
a la noche o pasar a un plan pago.

## Siguiente paso recomendado
Esta versión guarda todo el sistema como un solo bloque de datos. Para varios años de
ventas o muchos usuarios a la vez, lo ideal es pasar a una base con tablas
(Postgres en Neon o Supabase) y que el servidor asigne los números de ticket.
