// Repuestos Core OS · si cambiás algo de index.html, corré:  node actualizar-huella.js
// Calcula la huella del código de index.html y la pone en vercel.json. La página solo ejecuta
// el código que coincide con esa huella: así, si alguien logra meter código, no corre.
// Si te olvidás de correrlo después de editar index.html, el sistema abre en blanco.
const fs = require('fs'), crypto = require('crypto'), path = require('path');
const dir = __dirname;
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (scripts.length !== 1) { console.error('Se esperaba un solo <script> en index.html y hay ' + scripts.length); process.exit(1); }
const h = 'sha256-' + crypto.createHash('sha256').update(scripts[0], 'utf8').digest('base64');
const vj = path.join(dir, 'vercel.json');
const v = JSON.parse(fs.readFileSync(vj, 'utf8'));
let n = 0;
for (const blk of v.headers || []) for (const x of blk.headers || []) if (x.key === 'Content-Security-Policy') { x.value = x.value.replace(/'sha256-[A-Za-z0-9+/=]+'/, `'${h}'`); n++; }
if (!n) { console.error('No encontré la regla Content-Security-Policy en vercel.json'); process.exit(1); }
fs.writeFileSync(vj, JSON.stringify(v, null, 2) + '\n');
console.log('Listo: huella actualizada en vercel.json (' + h.slice(0, 20) + '…)');
