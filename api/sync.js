// Repuestos Core OS · API de sincronización por registro (Vercel + Upstash Redis REST)
//
// GET  /api/sync?since=V          cambios desde la versión V (204 si no hay). since=0: carga inicial.
// POST /api/sync?since=V          {put,inc,obj} guarda cambios y devuelve lo nuevo desde V.
// POST /api/sync?op=next&t=X      reserva el próximo número de comprobante (atómico).
// GET  /api/sync?op=month&m=AAAA-MM  registros de un mes anterior.
// POST /api/sync?op=reset         {confirm:"BORRAR"} borra todos los datos.
//
// Modelo en Redis (prefijo rc2:):
//   c:<col>[:<mes>]  hash id -> JSON del registro (colecciones con fecha se parten por mes)
//   n:<col>:<campo>  hash id -> número (stock, deuda) con suma atómica
//   o                hash nombre -> JSON (caja, datos fiscales, listas, modelos)
//   chg              sorted set "clave|id" -> versión del último cambio
//   ver              versión global · num:<t> contador · nro:<t> hash número -> id
const crypto = require('crypto');

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const P = 'rc2:';
const PCOLS = ['ventas', 'comps', 'movs', 'compras', 'envios', 'cierres', 'log'];
const NCOLS = ['repuestos', 'clientes', 'ots', 'presus', 'pedidos'];
const OBJS = ['caja', 'fiscal', 'listas', 'modelos'];
const NUMF = { repuestos: 'stock', clientes: 'deuda' };
const CLAIMF = { comps: 'nro', ots: 'num', presus: 'num', pedidos: 'num', envios: 'num' };
const NUMT = ['FA', 'FB', 'FC', 'X', 'NCA', 'NCB', 'NCC', 'NCX', 'OT', 'PR', 'PD', 'EN'];
const CLAIM_T = { ots: 'OT', presus: 'PR', pedidos: 'PD', envios: 'EN' };
const MONTHS_ON_OPEN = 4;          // meses de historial que baja cada equipo al abrir
const MAX_CHANGES = 3000;          // más cambios que esto: se pide recarga completa
const MAX_PUT = 500, MAX_REC = 64 * 1024;
const RATE_PER_MIN = 240;          // pedidos por minuto por IP (por instancia)

const L_COMMIT = `-- COMMIT
local v = redis.call('INCR', KEYS[1])
for i = 1, #ARGV do redis.call('ZADD', KEYS[2], v, ARGV[i]) end
return v`;
const L_CLAIM = `-- CLAIM
local n = tonumber(ARGV[1])
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if (not cur) or cur == ARGV[2] or (ARGV[3] ~= '' and cur == ('r:' .. ARGV[3])) then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  local c = tonumber(redis.call('GET', KEYS[2]) or '0')
  if n > c then redis.call('SET', KEYS[2], n) end
  return n
end
local c = tonumber(redis.call('GET', KEYS[2]) or '0')
repeat c = c + 1 until redis.call('HSETNX', KEYS[1], tostring(c), ARGV[2]) == 1
redis.call('SET', KEYS[2], c)
return c`;
const L_CAS = `-- CAS
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if (cur == false and ARGV[2] == '') or cur == ARGV[2] then redis.call('HSET', KEYS[1], ARGV[1], ARGV[3]) return 1 end
return 0`;
const L_RESERVE = `-- RESERVE
for i = 2, #ARGV, 2 do
  local s = tonumber(redis.call('HGET', KEYS[1], ARGV[i]) or '0')
  if s < tonumber(ARGV[i + 1]) then return {-1, ARGV[i], tostring(s)} end
end
for i = 2, #ARGV, 2 do redis.call('HINCRBYFLOAT', KEYS[1], ARGV[i], -tonumber(ARGV[i + 1])) end
local c = tonumber(redis.call('GET', KEYS[3]) or '0')
repeat c = c + 1 until redis.call('HSETNX', KEYS[2], tostring(c), 'r:' .. ARGV[1]) == 1
redis.call('SET', KEYS[3], c)
return {c}`;
const L_NEXT = `-- NEXT
local c = tonumber(redis.call('GET', KEYS[2]) or '0')
repeat c = c + 1 until redis.call('HSETNX', KEYS[1], tostring(c), 'r:' .. ARGV[1]) == 1
redis.call('SET', KEYS[2], c)
return c`;

async function cmd(...args) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(args) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function pipe(cmds) {
  if (!cmds.length) return [];
  const out = [];
  for (let i = 0; i < cmds.length; i += 200) {
    const r = await fetch(URL_.replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(cmds.slice(i, i + 200)) });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(j.error || 'pipeline');
    j.forEach(x => { if (x.error) throw new Error(x.error); out.push(x.result); });
  }
  return out;
}
const pairs = a => { const o = {}; if (Array.isArray(a)) for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; return o; };
const ym = d => { const f = d && (d.fecha || d.hasta || d.desde); return typeof f === 'string' && /^\d{4}-\d{2}/.test(f) ? f.slice(0, 7) : '0000-00'; };
const keyOf = (c, d) => PCOLS.includes(c) ? `${P}c:${c}:${ym(d)}` : `${P}c:${c}`;
const keyOfM = (c, m) => PCOLS.includes(c) ? `${P}c:${c}:${/^\d{4}-\d{2}$/.test(m) ? m : '0000-00'}` : `${P}c:${c}`;
const colOf = key => key.slice(P.length + 2).split(':')[0];
function lastMonths(n) { const out = []; const d = new Date(); d.setUTCDate(1); for (let i = 0; i < n; i++) { out.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() - 1); } return out; }
function sameSecret(a, b) { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); }
const buckets = new Map();
function allow(ip) { const now = Date.now(); let b = buckets.get(ip); if (!b || now - b.t > 60000) { b = { t: now, n: 0 }; buckets.set(ip, b); } b.n++; if (buckets.size > 5000) buckets.clear(); return b.n <= RATE_PER_MIN; }
const parse = s => { try { return JSON.parse(s); } catch (e) { return null; } };

async function counters() { const v = await cmd('MGET', ...NUMT.map(t => P + 'num:' + t)); const o = {}; NUMT.forEach((t, i) => o[t] = Number(v[i] || 0)); return o; }

// Pasa los datos de la versión anterior (un solo bloque) al modelo por registro.
async function migrateV1() {
  const raw = await cmd('GET', 'rcos:state');
  const S = raw && parse(raw);
  if (!S || typeof S !== 'object') return false;
  const cmds = [], months = new Set();
  for (const c of [...PCOLS, ...NCOLS]) {
    const byKey = {};
    (S[c] || []).forEach(x => { const id = c === 'cierres' ? x.sid : c === 'log' ? (x.id || (x.fecha + '|' + (x.filtro || ''))) : x.id; if (!id) return; const k = keyOf(c, x); (byKey[k] = byKey[k] || []).push(id, JSON.stringify(x)); if (PCOLS.includes(c)) months.add(ym(x)); });
    Object.entries(byKey).forEach(([k, fv]) => { for (let i = 0; i < fv.length; i += 400) cmds.push(['HSET', k, ...fv.slice(i, i + 400)]); });
    const f = NUMF[c];
    if (f && (S[c] || []).length) cmds.push(['HSET', `${P}n:${c}:${f}`, ...(S[c]).flatMap(x => [x.id, String(Number(x[f]) || 0)])]);
  }
  OBJS.forEach(o => { if (S[o] != null) cmds.push(['HSET', P + 'o', o, JSON.stringify(S[o])]); });
  const num = S.num || {}, seq = S.seq || {};
  const cnt = { ...num, OT: seq.otn || 0, PR: seq.pr || 0, PD: seq.pd || 0, EN: seq.en || 0 };
  NUMT.forEach(t => cmds.push(['SET', P + 'num:' + t, String(Number(cnt[t]) || 0)]));
  (S.comps || []).forEach(x => cmds.push(['HSET', P + 'nro:' + x.tipo, String(x.nro), x.id]));
  if (months.size) cmds.push(['SADD', P + 'months', ...months]);
  cmds.push(['SET', P + 'ver', '1']);
  await pipe(cmds);
  return true;
}

async function full() {
  let ver = await cmd('GET', P + 'ver');
  if (ver === null && await migrateV1()) ver = '1';
  const allMonths = (await cmd('SMEMBERS', P + 'months')) || [];
  const recent = lastMonths(MONTHS_ON_OPEN).concat(['0000-00']);
  const keys = [...NCOLS.map(c => `${P}c:${c}`), ...PCOLS.flatMap(c => recent.map(m => `${P}c:${c}:${m}`))];
  const res = await pipe([...keys.map(k => ['HGETALL', k]), ['HGETALL', P + 'o'], ['HGETALL', `${P}n:repuestos:stock`], ['HGETALL', `${P}n:clientes:deuda`]]);
  const cols = {}; let count = 0;
  keys.forEach((k, i) => { const c = colOf(k); const recs = Object.values(pairs(res[i])).map(parse).filter(Boolean); count += recs.length; cols[c] = (cols[c] || []).concat(recs); });
  const ob = pairs(res[keys.length]); const objs = {}; Object.keys(ob).forEach(k => objs[k] = parse(ob[k]));
  const st = pairs(res[keys.length + 1]), de = pairs(res[keys.length + 2]);
  (cols.repuestos || []).forEach(r => { if (st[r.id] != null) r.stock = Number(st[r.id]); });
  (cols.clientes || []).forEach(c => { if (de[c.id] != null) c.deuda = Number(de[c.id]); });
  return { ver: Number(ver || 0), full: true, empty: count === 0 && !Object.keys(objs).length, cols, objs, nums: await counters(), months: allMonths.sort().reverse(), loaded: recent };
}

async function changes(since, ver) {
  if (!since || since > ver) return full();
  if (since === ver) return { ver, cols: {}, objs: {} };
  const mem = await cmd('ZRANGE', P + 'chg', '(' + since, String(ver), 'BYSCORE');
  if (mem.length > MAX_CHANGES) return full();
  const byKey = {};
  mem.forEach(m => { const i = m.indexOf('|'); (byKey[m.slice(0, i)] = byKey[m.slice(0, i)] || []).push(m.slice(i + 1)); });
  const keys = Object.keys(byKey);
  const repIds = byKey[`${P}c:repuestos`] || [], cliIds = byKey[`${P}c:clientes`] || [];
  const cmds = keys.map(k => ['HMGET', k, ...byKey[k]]);
  if (repIds.length) cmds.push(['HMGET', `${P}n:repuestos:stock`, ...repIds]);
  if (cliIds.length) cmds.push(['HMGET', `${P}n:clientes:deuda`, ...cliIds]);
  const res = await pipe(cmds);
  const cols = {}, objs = {};
  keys.forEach((k, i) => {
    if (k === P + 'o') { byKey[k].forEach((n, j) => { if (res[i][j] != null) objs[n] = parse(res[i][j]); }); return; }
    const c = colOf(k); cols[c] = (cols[c] || []).concat(res[i].map(parse).filter(Boolean));
  });
  let x = keys.length;
  if (repIds.length) { const v = res[x++]; const m = {}; repIds.forEach((id, j) => m[id] = v[j]); (cols.repuestos || []).forEach(r => { if (m[r.id] != null) r.stock = Number(m[r.id]); }); }
  if (cliIds.length) { const v = res[x++]; const m = {}; cliIds.forEach((id, j) => m[id] = v[j]); (cols.clientes || []).forEach(c => { if (m[c.id] != null) c.deuda = Number(m[c.id]); }); }
  return { ver, cols, objs, nums: await counters() };
}

async function write(body) {
  const put = Array.isArray(body.put) ? body.put : [], inc = Array.isArray(body.inc) ? body.inc : [];
  const obj = body.obj && typeof body.obj === 'object' ? body.obj : {};
  if (put.length > MAX_PUT || inc.length > MAX_PUT) return { error: 'Demasiados cambios juntos.', status: 413 };
  const all = [...PCOLS, ...NCOLS];
  for (const x of put) {
    if (!x || !all.includes(x.c) || typeof x.id !== 'string' || !x.id || x.id.length > 200 || !x.p || typeof x.p !== 'object' || Array.isArray(x.p)) return { error: 'Registro inválido.', status: 400 };
  }
  const renum = [];
  // 1) números: si otro equipo ya usó el mismo, el servidor asigna el siguiente libre
  for (const x of put) {
    const f = CLAIMF[x.c];
    if (f && x.p._claim) {
      const t = x.c === 'comps' ? String(x.p.tipo || '') : CLAIM_T[x.c];
      if (NUMT.includes(t) && Number(x.p[f]) > 0) {
        const n = Number(await cmd('EVAL', L_CLAIM, '2', P + 'nro:' + t, P + 'num:' + t, String(Number(x.p[f])), x.id, String(x.p.ntok || '')));
        if (n !== Number(x.p[f])) { renum.push({ c: x.c, id: x.id, n }); x.p[f] = n; }
      }
    }
    delete x.p._claim;
  }
  // 2) registros: se mezclan campo por campo con lo guardado (control de concurrencia por registro)
  const members = [], months = new Set();
  let todo = put.map(x => ({ x, k: keyOfM(x.c, x.m || ym(x.p)) }));
  todo.forEach(t => { members.push(t.k + '|' + t.x.id); if (PCOLS.includes(t.x.c)) months.add(t.k.split(':').pop()); });
  for (let attempt = 0; attempt < 8 && todo.length; attempt++) {
    const cur = await pipe(todo.map(t => ['HGET', t.k, t.x.id]));
    const evals = [];
    for (let i = 0; i < todo.length; i++) {
      const old = cur[i];
      const merged = Object.assign(old ? (parse(old) || {}) : {}, todo[i].x.p);
      const s = JSON.stringify(merged);
      if (s.length > MAX_REC) return { error: 'Un registro es demasiado grande.', status: 413 };
      evals.push(['EVAL', L_CAS, '1', todo[i].k, todo[i].x.id, old == null ? '' : old, s]);
    }
    const ok = await pipe(evals);
    todo = todo.filter((t, i) => Number(ok[i]) !== 1);
  }
  if (todo.length) return { error: 'Mucha actividad sobre los mismos datos. Probá de nuevo.', status: 503 };
  // 3) stock y deuda: suma atómica, nunca se pisan entre equipos
  const cmds = [];
  for (const i of inc) {
    if (!i || !NUMF[i.c] || NUMF[i.c] !== i.f || typeof i.id !== 'string' || !isFinite(Number(i.n))) continue;
    cmds.push(['HINCRBYFLOAT', `${P}n:${i.c}:${i.f}`, i.id, String(Number(i.n))]);
    members.push(`${P}c:${i.c}|${i.id}`);
  }
  for (const [o, v] of Object.entries(obj)) { if (!OBJS.includes(o)) continue; const s = JSON.stringify(v); if (s.length > MAX_REC) continue; cmds.push(['HSET', P + 'o', o, s]); members.push(P + 'o|' + o); }
  if (months.size) cmds.push(['SADD', P + 'months', ...months]);
  await pipe(cmds);
  const uniq = [...new Set(members)];
  const ver = uniq.length ? Number(await cmd('EVAL', L_COMMIT, '2', P + 'ver', P + 'chg', ...uniq)) : Number(await cmd('GET', P + 'ver') || 0);
  return { ver, renum };
}

async function wipe() {
  let cursor = '0';
  do {
    const [next, keys] = await cmd('SCAN', cursor, 'MATCH', P + '*', 'COUNT', '500');
    cursor = String(next);
    if (keys.length) await cmd('DEL', ...keys);
  } while (cursor !== '0');
  await cmd('DEL', 'rcos:state', 'rcos:version');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (code, o) => { res.statusCode = code; res.end(o === undefined ? '' : JSON.stringify(o)); };
  const pin = process.env.APP_PIN;
  if (!pin) return send(500, { error: 'Falta configurar la clave APP_PIN en Vercel.' });
  if (!URL_ || !TOKEN) return send(500, { error: 'Falta conectar la base de datos (Upstash Redis) al proyecto.' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconocida';
  if (!allow(ip)) return send(429, { error: 'Demasiados pedidos seguidos. Esperá un momento.' });
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  try {
    if (!sameSecret(req.headers['x-app-pin'], pin)) {
      const fk = P + 'fail:' + ip;
      const fails = Number(await cmd('INCR', fk)); if (fails === 1) await cmd('EXPIRE', fk, '900');
      return send(fails > 10 ? 429 : 401, { error: fails > 10 ? 'Demasiados intentos. Esperá 15 minutos.' : 'Clave incorrecta.' });
    }
    let body = req.body;
    if (typeof body === 'string') body = parse(body);
    body = body || {};
    const since = Number(q.since || 0);

    if (q.op === 'next' && req.method === 'POST') {
      const t = String(q.t || '');
      if (!NUMT.includes(t)) return send(400, { error: 'Tipo inválido.' });
      const tok = crypto.randomBytes(6).toString('hex');
      const n = Number(await cmd('EVAL', L_NEXT, '2', P + 'nro:' + t, P + 'num:' + t, tok));
      return send(200, { n, tok });
    }
    if ((q.op === 'reserve' || q.op === 'release') && req.method === 'POST') {
      const items = (Array.isArray(body.items) ? body.items : []).filter(i => i && typeof i.id === 'string' && Number(i.q) > 0).slice(0, 200);
      if (q.op === 'release') {
        if (items.length) await pipe(items.map(i => ['HINCRBYFLOAT', `${P}n:repuestos:stock`, i.id, String(Number(i.q))]));
        if (items.length) await cmd('EVAL', L_COMMIT, '2', P + 'ver', P + 'chg', ...items.map(i => `${P}c:repuestos|${i.id}`));
        return send(200, { ok: true });
      }
      const t = String(body.t || '');
      if (!NUMT.includes(t)) return send(400, { error: 'Tipo inválido.' });
      const tok = crypto.randomBytes(6).toString('hex');
      const r = await cmd('EVAL', L_RESERVE, '3', `${P}n:repuestos:stock`, P + 'nro:' + t, P + 'num:' + t, tok, ...items.flatMap(i => [i.id, String(Number(i.q))]));
      if (Number(r[0]) === -1) return send(409, { error: 'sin-stock', id: r[1], stock: Number(r[2]) });
      if (items.length) await cmd('EVAL', L_COMMIT, '2', P + 'ver', P + 'chg', ...items.map(i => `${P}c:repuestos|${i.id}`));
      return send(200, { n: Number(r[0]), tok });
    }
    if (q.op === 'month' && req.method === 'GET') {
      const m = String(q.m || '');
      if (!/^\d{4}-\d{2}$/.test(m)) return send(400, { error: 'Mes inválido.' });
      const r = await pipe(PCOLS.map(c => ['HGETALL', `${P}c:${c}:${m}`]));
      const cols = {}; PCOLS.forEach((c, i) => cols[c] = Object.values(pairs(r[i])).map(parse).filter(Boolean));
      return send(200, { month: m, cols });
    }
    if (q.op === 'reset' && req.method === 'POST') {
      if (body.confirm !== 'BORRAR') return send(400, { error: 'Falta confirmar.' });
      await wipe();
      return send(200, { ok: true, ver: 0 });
    }
    if (req.method === 'GET') {
      const ver = Number(await cmd('GET', P + 'ver') || 0);
      if (since && since === ver) return send(204);
      return send(200, await changes(since, ver));
    }
    if (req.method === 'POST') {
      const w = await write(body);
      if (w.error) return send(w.status, { error: w.error });
      if (!since) return send(200, { ver: w.ver, renum: w.renum, stale: true });
      const ch = await changes(since, w.ver);
      if (ch.full) return send(200, { ver: w.ver, renum: w.renum, stale: true });
      return send(200, { ...ch, renum: w.renum });
    }
    res.setHeader('Allow', 'GET, POST');
    return send(405, { error: 'Método no permitido.' });
  } catch (e) {
    console.error(e);
    return send(500, { error: 'Error de la base de datos. Probá de nuevo en un momento.' });
  }
};
