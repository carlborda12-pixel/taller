# Repuestos Core OS: publicación en Vercel con base de datos

Versión 2 de la sincronización, pensada para un taller con hasta ~10 equipos
trabajando a la vez.

## Archivos
- `index.html`: el sistema.
- `manifest.webmanifest`, `sw.js` e `icons/`: hacen que se pueda instalar como app
  y que abra sin internet.
- `api/sync.js`: la función de Vercel que guarda y reparte los cambios.
- `api/backup.js`: la copia de seguridad de todos los días (la llama Vercel sola).
- `vercel.json`: ubica la función en São Paulo (gru1), cerca de Misiones, y agrega las
  protecciones de la página.
- `vendor/`: el lector de Excel (SheetJS 0.20.3), guardado acá en vez de bajarlo de afuera.
- `actualizar-huella.js`: **correlo cada vez que edites `index.html`** (ver Seguridad).
- `package.json`: no necesita dependencias.

**Si ya habías subido la versión anterior:** borrá `api/state.js` del repositorio.
Los datos que ya estaban cargados se pasan solos al formato nuevo la primera vez que
alguien entra.

## Pasos (una sola vez)
1. Subí esta carpeta a GitHub e importala en Vercel (Add New → Project, Framework: Other).
2. **Storage → Create Database → Upstash for Redis** (plan Free). Elegí la región
   **São Paulo** y conectala al proyecto.
3. **Settings → Environment Variables:**
   - `APP_PIN` = clave del taller, la que usan todos los equipos (8 caracteres o más).
   - `ADMIN_PIN` = **clave para borrar**, solo para el dueño. Se pide para borrar todo o
     para volver a una copia. Tiene que ser distinta de `APP_PIN`. Sin ella, nadie puede
     borrar la base desde el sistema.
   - `CRON_SECRET` = cualquier texto largo inventado (por ejemplo 30 letras y números).
     Vercel lo usa para hacer la copia diaria y nadie más la puede disparar.
   - `GOOGLE_CLIENT_ID` (opcional) = para que se pueda entrar con Google. Ver "Entrar con
     Google" más abajo. Sin esto, se entra con correo y contraseña.
4. **Redeploy**.
5. **Settings → Deployment Protection:** activá la protección de las versiones de prueba
   (Preview). Las versiones de prueba usan la misma base de datos real; así solo las abre
   quien tenga acceso a tu cuenta de Vercel.

## Usuarios (cada persona con su correo y contraseña)
Al principio todos entran con la clave del taller (`APP_PIN`). Para pasar a usuarios:
1. Entrá como dueño → **Tu usuario** (abajo a la izquierda, o en Ayuda) → **Activar
   usuarios**. Creás tu cuenta con tu correo y una contraseña de 10 caracteres o más;
   para confirmar se pide la clave para borrar (`ADMIN_PIN`).
2. Desde **Tu usuario → Usuarios del taller** cargás a cada persona con su correo, una
   contraseña inicial (el botón "Generar" arma una) y su rol.
3. Desde ese momento **la clave del taller deja de servir** y cada equipo pide usuario.

Qué puede hacer cada rol (lo controla el servidor, no solo la pantalla):
- **Dueño:** todo, incluidos usuarios, copias de seguridad, datos fiscales, listas de
  precios, comisiones y ganancia.
- **Mostrador:** vende, cobra, abre y cierra la caja, carga clientes y stock. No puede
  cambiar datos fiscales, listas de precios, comisiones ni usuarios, ni ver copias.
- **Técnico:** ve y avanza los arreglos y consulta el stock. Al servidor ni siquiera le
  llegan las ventas, la caja ni los comprobantes para ese usuario.

Otras cosas:
- Cada cambio queda firmado con el nombre de quien lo hizo (lo pone el servidor).
- **Si alguien deja de trabajar:** desactivalo en Usuarios. Se le cierra la sesión en
  todos los equipos y no puede volver a entrar.
- **"Salir de este equipo"** borra del equipo todos los datos del taller. Si en un mismo
  equipo entra otra persona, no ve nada de lo que había cargado la anterior.
- La sesión dura 30 días y la app no la puede leer (no se la puede llevar ni un código
  inyectado).
- **Intentos:** 20 contraseñas mal contra una misma cuenta la frenan una hora, aunque
  vengan de conexiones distintas. Siguen valiendo los 10 intentos por conexión.
- **Si el dueño se olvida la contraseña:** en la pantalla de ingreso, "¿Te olvidaste la
  contraseña?" → "recuperá tu cuenta" con la clave para borrar (`ADMIN_PIN`).
- **Sin internet:** si el equipo entró en las últimas 12 horas, abre igual (con huella,
  si está activada) y sube los cambios cuando vuelve la conexión.

## Desbloqueo con huella o cara
Después de entrar, el sistema ofrece que ese equipo se desbloquee con la huella o la
cara (también desde Tu usuario). Se pide al abrir la app y cuando estuvo 5 minutos sin
usarse. Es un candado de ese equipo: no reemplaza al usuario, solo evita que alguien
que agarra el celular o la PC vea los datos.

## Entrar con Google (opcional)
1. Entrá a console.cloud.google.com con la cuenta de Google del taller y creá un proyecto.
2. **APIs y servicios → Pantalla de consentimiento de OAuth:** tipo "Externo", nombre
   "Repuestos Core OS" y tu correo. Guardá.
3. **Credenciales → Crear credenciales → ID de cliente de OAuth → Aplicación web.** En
   **Orígenes de JavaScript autorizados** poné la dirección del sistema, por ejemplo
   `https://tu-taller.vercel.app` (y tu dominio propio si tenés).
4. Copiá el **ID de cliente** (termina en `.apps.googleusercontent.com`) y pegalo en
   Vercel como `GOOGLE_CLIENT_ID`. **Redeploy.** No hace falta el "secreto".
5. En Usuarios, marcá "Puede entrar con su cuenta de Google" en cada persona. Solo entran
   las cuentas de la lista, con el correo verificado por Google.

## Copias de seguridad
- **Todos los días** se guarda sola una copia completa: a las 6 de la mañana (cron de
  Vercel) o, si eso no está configurado, con el primer cambio del día.
- **Antes de borrar todo o de volver a una copia** se guarda otra copia, por las dudas.
- Quedan las últimas 14 diarias. De las otras (a mano, antes de borrar, antes de
  restaurar) quedan las últimas 10, hasta 30 días. A mano se puede hacer una cada 10 minutos.
- En el sistema: **Ayuda → Copias de seguridad**. Ahí se ven, se **descargan** (conviene
  bajar una por semana a un pendrive o al correo, porque las del sistema viven en la misma
  base de datos) y se vuelve a cualquiera con la clave para borrar, también desde un
  archivo descargado.

## Instalar la app en cada equipo
Una vez publicado en Vercel (con https):
- **PC (Chrome o Edge):** el botón **"Instalar app"** del sistema, o el ícono de instalar
  en la barra de direcciones. Queda en el escritorio y en el menú Inicio.
- **Android (Chrome):** el botón **"Instalar app"**, o el menú ⋮ → "Instalar app".
- **iPhone o iPad (Safari):** Compartir → "Agregar a inicio".

Se abre en su propia ventana, sin barra del navegador. En iPhone y iPad muestra la
pantalla de arranque con el logo mientras carga. Si se corta internet, abre igual
y sube los cambios cuando vuelve la conexión. Al mantener apretado el ícono aparecen
accesos directos a Vender, Stock y Caja.

**Para publicar una versión nueva:** cambiá `VERSION` al principio de `sw.js` (por
ejemplo, de `rcos-2.5.0` a `rcos-2.5.1`). Así todos los equipos bajan la actualización
solos, y se ve la próxima vez que abren la app.

## En el celular
- Abajo hay una barra con las 6 secciones, como en cualquier app.
- Las tablas se ven como tarjetas, una abajo de la otra.
- **Mostrar al cliente:** en Vender (y en cada presupuesto) abre una pantalla limpia,
  con letra grande, lo que lleva y el total, para darle vuelta el celular al cliente.
  Desde ahí se le manda por WhatsApp al número que tiene cargado.

## Caja: comisiones, mes a mes y ganancia
- **Comisiones de cobro** (Caja → "Comisiones de cobro", solo dueño): cargás el % que te
  cobran transferencia, Mercado Pago, débito y crédito. Desde ese momento la caja anota
  lo que realmente te llega (cobrado menos comisión) y guarda las dos cosas. Lo cobrado
  antes no cambia.
- **Mes a mes:** cada mes con lo cobrado, las comisiones, lo que entró, lo que salió y lo
  que quedó, comparado con el mes anterior, y lo que entró por cada medio de pago.
- **Ganancia:** lo vendido (tickets, facturas y arreglos entregados, con IVA incluido)
  contra lo que costaron esos repuestos y las comisiones. Por origen, por categoría y lo
  que más ganancia dejó. Cada venta guarda el costo que tenía el repuesto ese día, así la
  ganancia no cambia si después actualizás costos. Avisa si hay repuestos sin costo.

## Proveedores y avisos de stock
- **Stock → Pedidos a proveedores → Proveedores:** ficha de cada uno (celular, contacto,
  correo, CUIT, nota), sus repuestos, lo que está para reponer, sus pedidos y lo que le
  compraste. Se crean solos con los nombres que ya usabas en los repuestos.
- Con el celular cargado, **"Mandar por WhatsApp"** abre el chat de ese proveedor con el
  pedido escrito. Sin celular, se copia el texto como antes.
- **"Avisarme en este equipo"**: cuando un repuesto llega al mínimo, el equipo muestra una
  notificación (al tocarla abre Stock) y el ícono de la app muestra cuántos hay para
  reponer. Avisa mientras la app está abierta o en segundo plano; con la app cerrada del
  todo no llega, porque para eso haría falta un servidor de avisos aparte. En iPhone
  funciona con la app instalada en el inicio (iOS 16.4 o más nuevo).

## Exportar a Excel
Stock, Clientes, Caja de hoy, Mes a mes, Ganancia, Proveedores y Libro IVA tienen
**"Exportar CSV" / "Descargar CSV"** (solo dueño). Los archivos usan `;` entre columnas,
coma decimal y la marca de UTF-8, así Excel en Argentina los abre bien a la primera, con
tildes y ñ. Un texto que empieza con `=`, `+`, `-` o `@` se guarda con un apóstrofo para que
Excel no lo tome como fórmula.

## Seguridad
- **La página solo ejecuta su propio código.** `vercel.json` trae la huella del código de
  `index.html`; si alguien logra meter código en un dato (un nombre, un CUIT), el navegador
  no lo ejecuta. **Si editás `index.html`, corré `node actualizar-huella.js` antes de subirlo**:
  si no, el sistema abre en blanco.
- **No se puede meter el sistema dentro de otra página** (evita que te hagan tocar botones
  sin darte cuenta).
- **Lector de Excel actualizado** a SheetJS 0.20.3, que corrige la falla de planillas armadas
  a propósito (CVE-2023-30533). Se guarda en `vendor/` y el navegador verifica que el archivo
  sea exactamente ese antes de usarlo. Viene del paquete `@e965/xlsx` de npm, que vuelve a
  publicar sin cambios el archivo oficial de SheetJS; se comprobó la firma de npm y el
  registro de cómo se armó. Los caracteres especiales de sus tablas internas se pasaron a
  su forma escrita (`\x1b`, `\u00e9`, etc.) para que el archivo sea texto común, sin cambiar
  cómo funciona: se comprobó que lee igual
  `.xlsx`, `.xls`, `.ods`, `.xlsb` y `.csv`. Se siguen aceptando los mismos formatos.
- **Restaurar una copia** tiene un límite de 64 MB al descomprimir.
- **Pedidos de afuera no gastan la base.** Un pedido sin clave, o desde una conexión ya
  bloqueada, se rechaza sin consultar Upstash. Así nadie puede agotar las 500.000
  operaciones gratis del mes mandando pedidos.
- **Mientras dura un bloqueo**, la clave correcta y una equivocada reciben la misma
  respuesta: no sirve seguir probando.
- **Una venta ya guardada no puede "devolver" su stock** con su código; para devolver
  mercadería está la nota de crédito.
- **Topes:** hasta 100.000 unidades por ítem en una venta, 1.000.000 por movimiento de
  stock y 10.000 millones por movimiento de deuda. Lo que pase eso se rechaza.
- **La clave se compara sin revelar cuántos caracteres tiene.**

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
- **Una venta nunca se descuenta dos veces.** Cada venta lleva un código único. Si el
  servidor tarda (pasa cuando Vercel estuvo un rato sin uso), el equipo reintenta con el
  mismo código y el servidor la procesa una sola vez. Si no contesta, la venta se hace
  igual y queda en cola hasta que se confirma. Lo mismo con cada lote de cambios de stock
  y deuda: si se corta la respuesta, el reintento no suma dos veces.
- **Límites de seguridad.** 240 pedidos por minuto por conexión y registros de 64 KB como
  máximo. **10 claves incorrectas bloquean esa conexión 15 minutos, aunque después
  escriba la clave correcta.** Ojo: todos los equipos del taller suelen salir a internet
  por la misma conexión, así que alguien que se equivoque 10 veces deja al taller 15
  minutos sin sincronizar (las ventas se siguen haciendo y se suben después). Un equipo
  con la clave vieja guardada no sigue probando solo: pide la clave una vez y espera.

## Pruebas realizadas (con una base Redis simulada)
- 10 equipos vendiendo el mismo repuesto a la vez: stock correcto en todos y tickets
  del 1 al 10 sin repetir.
- 50 intentos de venta sobre 35 unidades: salieron 35, el stock quedó en 0 y las otras
  15 se frenaron con aviso.
- Cambio de costo y venta simultáneos sobre el mismo repuesto: se conservaron los dos.
- Venta sin internet: se sincronizó al volver, con número corregido si hacía falta.
- Servidor que contesta a los 8 segundos, que no contesta nunca, o pedido que llega
  tarde: en los tres casos el stock bajó una sola vez.
- Respuesta cortada al subir +5 de stock: quedó +5, no +10.
- Venta que falla al cobrar después de reservar: el stock vuelve.
- 10 claves mal: bloqueado aunque después use la correcta; otras conexiones siguen.
- Borrar sin la clave para borrar: rechazado. Con la clave: guarda copia y borra.
- Volver a una copia (del sistema y desde archivo): servidor y equipos quedan como en la
  copia.
- Usuarios: el equipo con la clave vieja pasa a pedir usuario; el mostrador no puede
  hacerse dueño ni cambiar datos fiscales o listas (aunque lo intente directo contra el
  servidor); al técnico no le llegan ventas ni caja; desactivar a alguien lo saca de todos
  los equipos; "Salir" borra los datos del equipo.
- Google (con claves de prueba): rechaza firma falsa, otra aplicación, correo sin
  verificar, token vencido y cuentas que no están en la lista.
- 20 contraseñas mal contra una cuenta, cada una desde otra conexión: queda frenada una
  hora, incluso con la contraseña correcta.
- Huella (con un lector simulado): pide la huella al abrir y tras 5 minutos sin uso;
  sin internet abre si entró en las últimas 12 horas.
- Comisiones, ganancia, proveedores, WhatsApp al proveedor, avisos de stock, CSV y
  sincronización de todo eso entre dos equipos.

## Costos de Upstash
El plan gratis incluye 500.000 operaciones por mes. Una venta gasta unas 14
operaciones y una consulta sin cambios, 1. Con 10 equipos en uso todo el día puede
pasarse del plan gratis. El plan por uso cuesta poco, pero conviene revisar el panel
de Upstash el primer mes.

## Si en el futuro crece más
Para varias sucursales o venderlo a otros talleres, el paso siguiente es Postgres con
tablas (Neon o Supabase) y factura electrónica real con ARCA.
