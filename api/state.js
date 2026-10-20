// API de sincronización: guarda todo el sistema en Upstash Redis (Vercel Marketplace).
// GET  /api/state            -> { version, data }
// GET  /api/state?since=N    -> 204 si no hubo cambios desde la versión N
// PUT  /api/state {base,data} -> { version } o 409 { version, data } si otro dispositivo guardó antes
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const KEY = 'rcos:state';
const VKEY = 'rcos:version';
const MAX_FAILS = 10;          // intentos de clave fallidos permitidos
const BLOCK_SECONDS = 15 * 60; // bloqueo por IP tras superar el límite

// Guarda solo si nadie guardó antes (compare-and-set atómico).
const CAS = `
local v = tonumber(redis.call('GET', KEYS[2]) or '0')
if v ~= tonumber(ARGV[1]) then return -1 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], v + 1)
return v + 1`;

function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const pin = process.env.APP_PIN;
  if (!pin) return res.status(500).json({ error: 'Falta configurar la clave APP_PIN en Vercel.' });
  if (!(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL))
    return res.status(500).json({ error: 'Falta conectar la base de datos (Upstash Redis) al proyecto.' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconocida';
  const failKey = 'rcos:fail:' + ip;
  try {
    const fails = Number((await redis.get(failKey)) || 0);
    if (fails >= MAX_FAILS) return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos.' });
    if (!sameSecret(req.headers['x-app-pin'], pin)) {
      await redis.incr(failKey);
      await redis.expire(failKey, BLOCK_SECONDS);
      return res.status(401).json({ error: 'Clave incorrecta.' });
    }

    if (req.method === 'GET') {
      const v = Number((await redis.get(VKEY)) || 0);
      const since = Number(req.query && req.query.since);
      if (since && since === v) return res.status(204).end();
      const data = await redis.get(KEY);
      return res.status(200).json({ version: v, data: data || null });
    }

    if (req.method === 'PUT') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data))
        return res.status(400).json({ error: 'Datos inválidos.' });
      const next = Number(await redis.eval(CAS, [KEY, VKEY], [String(Number(body.base) || 0), JSON.stringify(body.data)]));
      if (next === -1) {
        const [v, data] = await Promise.all([redis.get(VKEY), redis.get(KEY)]);
        return res.status(409).json({ version: Number(v || 0), data: data || null });
      }
      return res.status(200).json({ version: next });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Método no permitido.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Error de la base de datos. Probá de nuevo en un momento.' });
  }
};
