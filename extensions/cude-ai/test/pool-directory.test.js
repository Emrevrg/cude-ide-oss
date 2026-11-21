const test=require('node:test');const assert=require('node:assert/strict');
const {generateKeyPairSync,sign}=require('node:crypto');
const {verifyPoolDirectory,directoryUrl,pickHealthyPool}=require('../out/poolDirectory.js');
const {publicKey,privateKey}=generateKeyPairSync('ed25519');const pem=publicKey.export({type:'spki',format:'pem'});
const make=(pool)=>({pool,signature:sign(null,Buffer.from(JSON.stringify(pool)),privateKey).toString('base64')});
test('signed pool directory: accepts valid, rejects tampered, http and expired',()=>{
  const now=Date.now();const pool={schema:1,urls:['https://a.example','https://b.example/'],issuedAt:now,expiresAt:now+86400000};
  assert.deepEqual(verifyPoolDirectory(make(pool),pem,now).urls,['https://a.example','https://b.example']);
  const env=make(pool);env.pool={...pool,urls:['https://evil.example']};assert.throws(()=>verifyPoolDirectory(env,pem,now),/signature/);
  assert.throws(()=>verifyPoolDirectory(make({...pool,urls:['http://a.example']}),pem,now),/HTTPS/);
  assert.throws(()=>verifyPoolDirectory(make({...pool,expiresAt:now-1}),pem,now),/validity/);
  assert.equal(directoryUrl('https://emrevrg.github.io/cude-ide-releases/update/manifest.json'),'https://emrevrg.github.io/cude-ide-releases/pool.json');
});
test('pickHealthyPool falls back to the next server',async()=>{
  const seen=[];const fake=async(url)=>{seen.push(url);if(url.startsWith('https://a'))throw new Error('down');return new Response('{"ok":true}');};
  assert.equal(await pickHealthyPool(['https://a.example','https://b.example'],fake),'https://b.example');
});
