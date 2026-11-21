// Adds lobehub (MIT) logos for catalog providers to media/provider-icons.json under "cat:<providerId>".
'use strict';
const fs=require('node:fs'),path=require('node:path');
const dir=process.argv[2];const ext=path.join(__dirname,'..','extensions','cude-ai');
const out=path.join(ext,'media','provider-icons.json');const icons=Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(out,'utf8'))).filter(([k])=>!k.startsWith('cat:')));
const catalog=JSON.parse(fs.readFileSync(path.join(ext,'data','model-catalog.json'),'utf8'));
const files=new Set(fs.readdirSync(dir).filter(f=>f.endsWith('.svg')).map(f=>f.slice(0,-4)));
const norm=s=>String(s||'').toLowerCase().replace(/\(.*?\)/g,'').replace(/[^a-z0-9]+/g,'');
const rank=f=>f.endsWith('-color')?0:/-(text|brand|text-cn|cn|brand-color)$/.test(f)?2:1;
const byNorm=new Map();for(const f of files){const base=f.replace(/-(color|text|brand|brand-color|text-cn|cn)$/,'');const k=norm(base);if(!byNorm.has(k)||rank(f)<rank(byNorm.get(k)))byNorm.set(k,f);}
const SKIP=new Set(['boundless','bothub','blueclaw','inference-coop','inferenceapis']);
const pick=k=>{if(!k)return;const f=byNorm.get(k);if(!f||/-(text|text-cn)$/.test(f))return;return f;};
let added=0;
for(const p of catalog.providers){
  if(icons['cat:'+p.id]||SKIP.has(p.id))continue;
  let host='';try{host=new URL(p.api||p.doc||'').hostname.replace(/^(api|www|router|inference|gateway)\./,'');}catch{}
  const cands=[norm(p.id),norm(p.name),norm(p.id.split(/[-_]/)[0]),norm(p.name.split(/\s+/)[0]),norm(host.split('.')[0])];
  const f=cands.map(pick).find(Boolean);if(!f)continue;
  let svg=fs.readFileSync(path.join(dir,f+'.svg'),'utf8').replace(/<\?xml[^>]*>/,'').replace(/<title>.*?<\/title>/s,'').trim();
  if(!/^<svg[\s\S]*<\/svg>$/.test(svg)||/<script|on[a-z]+=/i.test(svg))continue;
  icons['cat:'+p.id]=svg;added++;
}
fs.writeFileSync(out,JSON.stringify(icons));
console.log('catalog icons added',added,'of',catalog.providers.length,'size',fs.statSync(out).size);
