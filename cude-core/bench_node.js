// Aynı işin Node (TypeScript eklentisinin çalıştığı ortam) karşılığı: dosya gezme + "TODO" arama. Karşılaştırma için.
const fs = require('fs'), path = require('path');
const root = process.argv[2] || '.';
const skip = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', '.next', '.venv', 'coverage', 'vendor']);
function walk(d, acc) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.join(d, e.name), acc); } else if (e.isFile()) acc.push(path.join(d, e.name)); } return acc; }
let t = process.hrtime.bigint(); const files = walk(root, []);
console.log('index      ', (Number(process.hrtime.bigint() - t) / 1e6).toFixed(1), 'ms  sonuc=' + files.length);
t = process.hrtime.bigint(); let hits = 0;
for (const f of files) { try { const s = fs.statSync(f); if (s.size > 1e6 || /\.(png|jpg|gif|ico|pdf|zip|exe|dll|lock|woff2?|ttf|mp4|bin|node)$/i.test(f)) continue; for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (/todo/i.test(l) && ++hits >= 200) throw 0; } catch (e) { if (e === 0) break; } }
console.log('grep       ', (Number(process.hrtime.bigint() - t) / 1e6).toFixed(1), 'ms  sonuc=' + hits);
