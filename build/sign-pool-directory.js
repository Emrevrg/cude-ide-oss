// Writes the signed Cude Pool directory (pool.json) next to the update feed.
// Usage: node build/sign-pool-directory.js <out-dir> <https-url> [more-urls...]
// Key: CUDE_RELEASE_KEY or E:/Projeler/CudeIDE-anahtarlar/release-ed25519.pem (never committed, never printed).
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [out,...urls]=process.argv.slice(2);
if(!out||!urls.length){console.error('Usage: node sign-pool-directory.js <out-dir> <https-url> [...]');process.exit(1);}
for(const u of urls){const p=new URL(u);if(p.protocol!=='https:')throw Error('HTTPS only: '+u);}
const keyFile=process.env.CUDE_RELEASE_KEY||'E:/Projeler/CudeIDE-anahtarlar/release-ed25519.pem';
const key=crypto.createPrivateKey(fs.readFileSync(keyFile));
const now=Date.now();
const pool={schema:1,urls:urls.map(u=>new URL(u).origin),issuedAt:now,expiresAt:now+90*86400000};
const signature=crypto.sign(null,Buffer.from(JSON.stringify(pool)),key).toString('base64');
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'pool.json'),JSON.stringify({pool,signature},null,2)+'\n');
console.log('pool.json written:',pool.urls.join(', '),'valid until',new Date(pool.expiresAt).toISOString().slice(0,10));
