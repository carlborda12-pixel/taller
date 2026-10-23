// Repuestos Core OS · API de sincronización por registro (Vercel + Upstash Redis REST)
//
// GET  /api/sync?since=V          cambios desde la versión V (204 si no hay). since=0: carga inicial.
// POST /api/sync?since=V          {put,inc,obj} guarda cambios y devuelve lo nuevo desde V.
// POST /api/sync?op=next&t=X      reserva el próximo número de comprobante (atómico).
// GET  /api/sync?op=month&m=AAAA-MM  registros de un mes anterior.
// POST /api/sync?op=reserve       {t,items,rid,force,num} descuenta stock (y da número) una sola vez por código rid.
// POST /api/sync?op=release       {rid} devuelve lo descontado por esa venta (una sola vez).
// POST /api/sync?op=reset         {confirm:"BORRAR",admin} borra todo (pide ADMIN_PIN; antes guarda una copia).
// GET  /api/sync?op=backups       lista de copias de seguridad.
// POST /api/sync?op=backup        hace una copia ahora.
// GET  /api/sync?op=backup-get&id=X  baja una copia (para guardarla fuera).
// POST /api/sync?op=restore       {admin,id} o {admin,file} vuelve a una copia (pide ADMIN_PIN).
//
// Modelo en Redis (prefijo rc2:):
//   c:<col>[:<mes>]  hash id -> JSON del registro (colecciones con fecha se parten por mes)
//   n:<col>:<campo>  hash id -> número (stock, deuda) con suma atómica
//   o                hash nombre -> JSON (caja, datos fiscales, listas, modelos)
//   chg              sorted set "clave|id" -> versión del último cambio
//   ver              versión global · num:<t> contador · nro:<t> hash número -> id
//   floor            versión mínima válida (después de restaurar, los equipos recargan todo)
// Fuera del prefijo, para que no entren en las copias ni se borren:
//   rcx:rsv:<rid>    lo que descontó cada venta (para no descontar dos veces)
//   rcx:b:<id>       lotes de cambios ya aplicados (para no sumar dos veces stock o deuda)
//   rcx:fail:<ip> · rcx:lock:<ip>   intentos de clave fallidos y bloqueo
//   rcbk:idx · rcbk:<id>:<n> · rcbk:last   copias de seguridad
const crypto = require('crypto');
const zlib = require('zlib');

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
const MAX_FAILS = 10, LOCK_SECS = 900;   // 10 claves mal: 15 minutos bloqueado (aunque después acierte)
const IDEM_SECS = 30 * 86400;      // cuánto se recuerda una venta ya procesada
const BATCH_SECS = 7 * 86400;      // cuánto se recuerda un lote de cambios ya aplicado
const BK = 'rcbk:', BK_DAILY = 14, BK_OTHER_DAYS = 30, BK_CHUNK = 600000;
const BK_KEEP_OTHER = 10, BK_MANUAL_SECS = 600;   // copias a mano: una cada 10 minutos, quedan las últimas 10
const MAX_QTY = 100000;                           // unidades por ítem en una venta
const MAX_INC = { stock: 1000000, deuda: 10000000000 };   // tope por movimiento de stock y de deuda
const X = 'rcx:';
const okId = s => typeof s === 'string' && /^[A-Za-z0-9_.-]{6,80}$/.test(s);

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
// KEYS: 1 stock · 2 nro:<t> · 3 num:<t> · 4 rcx:rsv:<rid>
// ARGV: 1 tok · 2 force (1 = vender aunque no alcance: venta ya hecha sin conexión) · 3 dar número (1/0) · 4 ttl · luego id, cantidad...
// Si esa venta (rid) ya se procesó, devuelve lo mismo que la primera vez y no descuenta otra vez.
const L_RESERVE = `-- RESERVE
local done = redis.call('HGETALL', KEYS[4])
if #done > 0 then
  local h = {}
  for i = 1, #done, 2 do h[done[i]] = done[i + 1] end
  return {tonumber(h['n'] or '0'), h['tok'] or '', 1, h['st'] or 'ok'}
end
if ARGV[2] ~= '1' then
  for i = 5, #ARGV, 2 do
    local s = tonumber(redis.call('HGET', KEYS[1], ARGV[i]) or '0')
    if s < tonumber(ARGV[i + 1]) then return {-1, ARGV[i], tostring(s)} end
  end
end
for i = 5, #ARGV, 2 do
  redis.call('HINCRBYFLOAT', KEYS[1], ARGV[i], -tonumber(ARGV[i + 1]))
  redis.call('HSET', KEYS[4], 'i:' .. ARGV[i], ARGV[i + 1])
end
local c = 0
if ARGV[3] == '1' then
  c = tonumber(redis.call('GET', KEYS[3]) or '0')
  repeat c = c + 1 until redis.call('HSETNX', KEYS[2], tostring(c), 'r:' .. ARGV[1]) == 1
  redis.call('SET', KEYS[3], c)
end
redis.call('HSET', KEYS[4], 'n', tostring(c), 'tok', ARGV[1], 'st', 'ok')
redis.call('EXPIRE', KEYS[4], ARGV[4])
return {c, ARGV[1], 0, 'ok'}`;
// KEYS: 1 stock · 2 rcx:rsv:<rid> · ARGV: 1 ttl. Devuelve lo descontado una sola vez.
// Si la venta todavía no llegó, deja una marca para que, si llega tarde, no descuente.
const L_RELEASE = `-- RELEASE
local d = redis.call('HGETALL', KEYS[2])
if #d == 0 then
  redis.call('HSET', KEYS[2], 'st', 'rel', 'n', '0')
  redis.call('EXPIRE', KEYS[2], ARGV[1])
  return 0
end
local h = {}
for i = 1, #d, 2 do h[d[i]] = d[i + 1] end
if h['st'] == 'rel' then return 0 end
if h['st'] == 'used' then return -1 end
for k, v in pairs(h) do
  if string.sub(k, 1, 2) == 'i:' then redis.call('HINCRBYFLOAT', KEYS[1], string.sub(k, 3), v) end
end
redis.call('HSET', KEYS[2], 'st', 'rel')
return 1`;
// KEYS: 1 rcx:b:<lote> · 2 stock · 3 deuda · ARGV: 1 ttl, luego (2|3, id, cantidad)...
// Suma stock y deuda de un lote una sola vez, aunque el equipo lo mande de nuevo.
// Marca como usadas las reservas de las ventas que ya quedaron guardadas: después no se pueden devolver.
const L_USED = `-- USED
for i = 1, #KEYS do
  if redis.call('HGET', KEYS[i], 'st') == 'ok' then redis.call('HSET', KEYS[i], 'st', 'used') end
end
return 1`;
const L_INC = `-- INC
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 0 end
for i = 2, #ARGV, 3 do redis.call('HINCRBYFLOAT', KEYS[tonumber(ARGV[i])], ARGV[i + 1], ARGV[i + 2]) end
return 1`;
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
const dig = v => crypto.createHash('sha256').update(String(v || '')).digest();
function sameSecret(a, b) { return !!a && !!b && crypto.timingSafeEqual(dig(a), dig(b)); }
const buckets = new Map();
// Conexiones bloqueadas, recordadas en este servidor para no consultar la base en cada pedido.
const lockedMem = new Map();
const memLocked = ip => { const t = lockedMem.get(ip); if (!t) return false; if (Date.now() > t) { lockedMem.delete(ip); return false; } return true; };
const memLock = (ip, secs) => { if (lockedMem.size > 5000) lockedMem.clear(); lockedMem.set(ip, Date.now() + secs * 1000); };
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

async function changes(since, ver, floor) {
  if (floor === undefined) floor = Number(await cmd('GET', P + 'floor') || 0);
  if (!since || since > ver || since < floor) return full();
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
  // ventas guardadas: su reserva de stock ya no se puede devolver
  const usedK = [...new Set(put.filter(x => x.c === 'comps' && okId(x.p.rid)).map(x => X + 'rsv:' + x.p.rid))];
  if (usedK.length) await cmd('EVAL', L_USED, String(usedK.length), ...usedK);
  // 3) stock y deuda: suma atómica y una sola vez por lote (si el equipo reintenta, no se suma de nuevo)
  const cmds = [], incArgs = [];
  for (const i of inc) {
    if (!i || !NUMF[i.c] || NUMF[i.c] !== i.f || typeof i.id !== 'string' || !isFinite(Number(i.n))) continue;
    if (Math.abs(Number(i.n)) > MAX_INC[i.f]) return { error: 'Un movimiento de stock o deuda es demasiado grande.', status: 400 };
    incArgs.push(i.c === 'repuestos' ? '2' : '3', i.id, String(Number(i.n)));
    members.push(`${P}c:${i.c}|${i.id}`);
  }
  let dup = false;
  if (incArgs.length) {
    const bid = okId(body.bid) ? body.bid : crypto.randomBytes(9).toString('hex');
    dup = Number(await cmd('EVAL', L_INC, '3', X + 'b:' + bid, `${P}n:repuestos:stock`, `${P}n:clientes:deuda`, String(BATCH_SECS), ...incArgs)) === 0;
  }
  for (const [o, v] of Object.entries(obj)) { if (!OBJS.includes(o)) continue; const s = JSON.stringify(v); if (s.length > MAX_REC) continue; cmds.push(['HSET', P + 'o', o, s]); members.push(P + 'o|' + o); }
  if (months.size) cmds.push(['SADD', P + 'months', ...months]);
  await pipe(cmds);
  const uniq = [...new Set(members)];
  const ver = uniq.length ? Number(await cmd('EVAL', L_COMMIT, '2', P + 'ver', P + 'chg', ...uniq)) : Number(await cmd('GET', P + 'ver') || 0);
  return { ver, renum, dup };
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

// ---------- Copias de seguridad ----------
const hoyAR = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
async function scanKeys(match) {
  const out = []; let cursor = '0';
  do { const [next, keys] = await cmd('SCAN', cursor, 'MATCH', match, 'COUNT', '1000'); cursor = String(next); out.push(...keys); } while (cursor !== '0');
  return [...new Set(out)];
}
async function dumpAll() {
  const keys = (await scanKeys(P + '*')).filter(k => k !== P + 'chg' && k !== P + 'floor' && !k.startsWith(P + 'fail:'));
  const types = await pipe(keys.map(k => ['TYPE', k]));
  const get = { hash: k => ['HGETALL', k], string: k => ['GET', k], set: k => ['SMEMBERS', k], zset: k => ['ZRANGE', k, '0', '-1', 'WITHSCORES'] };
  const list = keys.map((k, i) => [k, types[i]]).filter(([, t]) => get[t]);
  const vals = await pipe(list.map(([k, t]) => get[t](k)));
  return { app: 'repuestos-core-os', v: 1, at: new Date().toISOString(), keys: list.map(([k, t], i) => [k, t, vals[i]]) };
}
async function saveBackup(motivo, id) {
  const d = await dumpAll();
  if (!d.keys.length) return null;
  const json = JSON.stringify(d);
  const gz = zlib.gzipSync(json, { level: 9 }).toString('base64');
  id = id || ('m-' + Date.now().toString(36));
  const chunks = Math.ceil(gz.length / BK_CHUNK);
  const meta = { id, at: d.at, dia: hoyAR(), motivo, bytes: json.length, gz: gz.length, chunks };
  const cmds = [];
  for (let i = 0; i < chunks; i++) cmds.push(['SET', `${BK}${id}:${i}`, gz.slice(i * BK_CHUNK, (i + 1) * BK_CHUNK)]);
  cmds.push(['HSET', BK + 'idx', id, JSON.stringify(meta)]);
  await pipe(cmds);
  await pruneBackups();
  return meta;
}
async function listBackups() { return Object.values(pairs(await cmd('HGETALL', BK + 'idx'))).map(parse).filter(Boolean).sort((a, b) => b.at < a.at ? -1 : 1); }
async function pruneBackups() {
  const all = await listBackups(), now = Date.now(), del = [];
  const daily = all.filter(m => m.motivo === 'diaria');
  daily.slice(BK_DAILY).forEach(m => del.push(m));
  const other = all.filter(m => m.motivo !== 'diaria');
  other.forEach((m, i) => { if (i >= BK_KEEP_OTHER || now - Date.parse(m.at) > BK_OTHER_DAYS * 86400000) del.push(m); });
  if (!del.length) return;
  const cmds = [];
  del.forEach(m => { for (let i = 0; i < m.chunks; i++) cmds.push(['DEL', `${BK}${m.id}:${i}`]); cmds.push(['HDEL', BK + 'idx', m.id]); });
  await pipe(cmds);
}
async function loadBackupGz(id) {
  const meta = parse(await cmd('HGET', BK + 'idx', String(id)));
  if (!meta) return null;
  const parts = await pipe(Array.from({ length: meta.chunks }, (_, i) => ['GET', `${BK}${meta.id}:${i}`]));
  if (parts.some(x => x == null)) return null;
  return { meta, gz: parts.join('') };
}
// Límite al descomprimir: un archivo armado para inflarse sin fin no tumba el servidor.
const MAX_RESTORE = 64 * 1024 * 1024;
function unpack(gz) { try { const d = JSON.parse(zlib.gunzipSync(Buffer.from(String(gz), 'base64'), { maxOutputLength: MAX_RESTORE }).toString('utf8')); return d && d.app === 'repuestos-core-os' && d.v === 1 && Array.isArray(d.keys) ? d : null; } catch (e) { return null; } }
async function restoreDump(d) {
  const keys = d.keys.filter(x => Array.isArray(x) && typeof x[0] === 'string' && x[0].startsWith(P) && !x[0].startsWith(P + 'fail:') && x[0] !== P + 'chg' && x[0] !== P + 'floor');
  const curVer = Number(await cmd('GET', P + 'ver') || 0);
  await wipe();
  const cmds = []; let oldVer = 0;
  for (const [k, t, v] of keys) {
    if (t === 'string') { if (k === P + 'ver') oldVer = Number(v || 0); else cmds.push(['SET', k, String(v)]); }
    else if (t === 'hash' && Array.isArray(v)) { for (let i = 0; i < v.length; i += 800) cmds.push(['HSET', k, ...v.slice(i, i + 800)]); }
    else if (t === 'set' && Array.isArray(v) && v.length) { for (let i = 0; i < v.length; i += 800) cmds.push(['SADD', k, ...v.slice(i, i + 800)]); }
    else if (t === 'zset' && Array.isArray(v)) { for (let i = 0; i < v.length; i += 800) { const a = []; for (let j = i; j < Math.min(v.length, i + 800); j += 2) a.push(v[j + 1], v[j]); if (a.length) cmds.push(['ZADD', k, ...a]); } }
  }
  const ver = Math.max(curVer, oldVer) + 1;
  cmds.push(['SET', P + 'ver', String(ver)], ['SET', P + 'floor', String(ver)]);
  await pipe(cmds);
  return ver;
}
// Una copia por día: la hace el cron de Vercel y, si no está configurado, el primer cambio del día.
async function dailyBackup(force) {
  const dia = hoyAR();
  if (!force && await cmd('GET', BK + 'last') === dia) return null;
  if (!await cmd('SET', BK + 'lock', dia, 'NX', 'EX', '300')) return null;
  try { const m = await saveBackup('diaria', 'd-' + dia); await cmd('SET', BK + 'last', dia); return m; }
  finally { await cmd('DEL', BK + 'lock'); }
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
  const LOCK_MSG = 'Demasiadas claves equivocadas desde esta conexión. Esperá 15 minutos.';
  const lockedOut = (secs) => { memLock(ip, secs || 60); res.setHeader('x-locked', '1'); return send(429, { error: LOCK_MSG, locked: true }); };
  const badPin = async (msg, code) => {
    const fk = X + 'fail:' + ip;
    const n = Number(await cmd('INCR', fk)); if (n === 1) await cmd('EXPIRE', fk, String(LOCK_SECS));
    // Al décimo: bloqueo y contador vencen juntos. Así, mientras dure el bloqueo, una clave
    // equivocada y la correcta reciben la misma respuesta y no se puede probar a ciegas.
    if (n >= MAX_FAILS) { if (n === MAX_FAILS) await pipe([['SET', X + 'lock:' + ip, '1', 'EX', String(LOCK_SECS)], ['EXPIRE', fk, String(LOCK_SECS)]]); return lockedOut(LOCK_SECS); }
    return send(code || 401, { error: msg });
  };
  // Sin clave, o desde una conexión que este servidor ya sabe bloqueada: se rechaza sin tocar la base.
  if (memLocked(ip)) return lockedOut();
  if (!req.headers['x-app-pin']) return send(401, { error: 'Falta la clave.' });
  try {
    // Clave equivocada: solo se cuenta el intento (al décimo queda bloqueada 15 minutos).
    if (!sameSecret(req.headers['x-app-pin'], pin)) return badPin('Clave incorrecta.');
    // Clave correcta: igual se revisa el bloqueo primero (bloqueado no entra ni con la clave correcta).
    // Un solo comando trae también la versión, el piso y la fecha de la última copia.
    const [locked, verS, floorS, lastBk] = await cmd('MGET', X + 'lock:' + ip, P + 'ver', P + 'floor', BK + 'last');
    if (locked) return lockedOut();
    const admin = process.env.ADMIN_PIN;
    const needAdmin = async (b) => {
      if (!admin) return send(403, { error: 'Para borrar o restaurar hace falta configurar la clave ADMIN_PIN en Vercel.' }), false;
      if (sameSecret(admin, pin)) return send(403, { error: 'La clave para borrar (ADMIN_PIN) tiene que ser distinta de la clave del taller.' }), false;
      if (!sameSecret(b.admin, admin)) { await badPin('La clave para borrar no es correcta.', 403); return false; }
      return true;
    };
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
      // Cada venta trae un código único (rid): si el pedido llega dos veces, se procesa una sola.
      if (!okId(body.rid)) return send(400, { error: 'Falta el código de la venta.' });
      const rk = X + 'rsv:' + body.rid;
      if (q.op === 'release') {
        const ids = Object.keys(pairs(await cmd('HGETALL', rk))).filter(k => k.startsWith('i:')).map(k => k.slice(2));
        const done = Number(await cmd('EVAL', L_RELEASE, '2', `${P}n:repuestos:stock`, rk, String(IDEM_SECS)));
        if (done === -1) return send(409, { error: 'Esa venta ya está registrada: el stock no se devuelve así. Para devolver, hacé una nota de crédito.' });
        if (done && ids.length) await cmd('EVAL', L_COMMIT, '2', P + 'ver', P + 'chg', ...ids.map(id => `${P}c:repuestos|${id}`));
        return send(200, { ok: true, released: !!done });
      }
      const agg = {};
      const raw = (Array.isArray(body.items) ? body.items : []).filter(i => i && typeof i.id === 'string' && i.id.length <= 200 && Number(i.q) > 0).slice(0, 200);
      if (raw.some(i => !isFinite(Number(i.q)) || Number(i.q) > MAX_QTY)) return send(400, { error: 'Cantidad fuera de rango.' });
      raw.forEach(i => { agg[i.id] = (agg[i.id] || 0) + Number(i.q); });
      const items = Object.entries(agg);
      const wantNum = body.num !== 0 && body.num !== false;
      const t = String(body.t || '');
      if (wantNum && !NUMT.includes(t)) return send(400, { error: 'Tipo inválido.' });
      const tok = crypto.randomBytes(6).toString('hex');
      const r = await cmd('EVAL', L_RESERVE, '4', `${P}n:repuestos:stock`, P + 'nro:' + (t || 'X'), P + 'num:' + (t || 'X'), rk, tok, body.force ? '1' : '0', wantNum ? '1' : '0', String(IDEM_SECS), ...items.flatMap(([id, n]) => [id, String(n)]));
      if (Number(r[0]) === -1) return send(409, { error: 'sin-stock', id: r[1], stock: Number(r[2]) });
      const replay = Number(r[2]) === 1;
      if (!replay && items.length) await cmd('EVAL', L_COMMIT, '2', P + 'ver', P + 'chg', ...items.map(([id]) => `${P}c:repuestos|${id}`));
      return send(200, { n: Number(r[0]), tok: r[1], replay, st: r[3] });
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
      if (!await needAdmin(body)) return;
      const copia = await saveBackup('antes de borrar');
      await wipe();
      return send(200, { ok: true, ver: 0, copia });
    }
    if (q.op === 'backups' && req.method === 'GET') return send(200, { list: await listBackups(), adminOk: !!process.env.ADMIN_PIN && !sameSecret(process.env.ADMIN_PIN, pin) });
    if (q.op === 'backup' && req.method === 'POST') {
      if (!await cmd('SET', BK + 'manual-lock', '1', 'NX', 'EX', String(BK_MANUAL_SECS))) return send(429, { error: 'Ya se hizo una copia hace menos de 10 minutos. Probá más tarde.' });
      const m = await saveBackup('manual'); return m ? send(200, m) : send(400, { error: 'Todavía no hay datos para copiar.' }); }
    if (q.op === 'backup-get' && req.method === 'GET') {
      const b = await loadBackupGz(q.id);
      if (!b) return send(404, { error: 'No se encontró esa copia.' });
      return send(200, { app: 'repuestos-core-os', copia: b.meta, gz: b.gz });
    }
    if (q.op === 'restore' && req.method === 'POST') {
      if (!await needAdmin(body)) return;
      let d = null;
      if (body.id) { const b = await loadBackupGz(body.id); if (!b) return send(404, { error: 'No se encontró esa copia.' }); d = unpack(b.gz); }
      else if (body.file && body.file.gz) d = unpack(body.file.gz);
      if (!d) return send(400, { error: 'El archivo no es una copia de este sistema o está dañado.' });
      const antes = await saveBackup('antes de restaurar');
      const ver = await restoreDump(d);
      return send(200, { ok: true, ver, antes });
    }
    if (req.method === 'GET') {
      const ver = Number(verS || 0);
      if (since && since === ver) return send(204);
      return send(200, await changes(since, ver, Number(floorS || 0)));
    }
    if (req.method === 'POST') {
      const w = await write(body);
      if (w.error) return send(w.status, { error: w.error });
      if (lastBk !== hoyAR()) { try { await dailyBackup(false); } catch (e) { console.error('copia diaria', e); } }
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
module.exports.dailyBackup = dailyBackup;
module.exports.ready = () => !!(URL_ && TOKEN);
