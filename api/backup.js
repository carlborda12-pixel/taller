// Repuestos Core OS · copia de seguridad diaria (la llama el cron de Vercel, ver vercel.json).
// Vercel manda "Authorization: Bearer <CRON_SECRET>". Sin CRON_SECRET configurado no hace nada,
// pero igual queda la copia que se hace sola con el primer cambio de cada día.
const crypto = require('crypto');
const sync = require('./sync.js');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (code, o) => { res.statusCode = code; res.end(JSON.stringify(o)); };
  const sec = process.env.CRON_SECRET;
  if (!sec) return send(500, { error: 'Falta configurar CRON_SECRET en Vercel.' });
  const got = Buffer.from(String(req.headers.authorization || '')), want = Buffer.from('Bearer ' + sec);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return send(401, { error: 'No autorizado.' });
  if (!sync.ready()) return send(500, { error: 'Falta conectar la base de datos.' });
  try { const m = await sync.dailyBackup(true); return send(200, { ok: true, copia: m }); }
  catch (e) { console.error(e); return send(500, { error: 'No se pudo hacer la copia.' }); }
};
