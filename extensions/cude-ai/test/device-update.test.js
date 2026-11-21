'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),c=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {newCui,validateIdentity,signedDeviceHeaders,dpapi}=require('../out/deviceId');
const {ActivityGate,requiresUpdate,verifiedInstall}=require('../out/updatePolicy');
const {verifyExtensionIntegrity}=require('../out/extensionIntegrity');
const {prepare}=require('../../../build/release-manifest');
const {verifyManifest,parseReleaseTrust}=require('../out/releaseClient');
test('CUI uses exactly 128 random bits and fingerprint mismatches are rejected',()=>{
 assert.equal(newCui(Buffer.alloc(16)),'CUI-'+'0'.repeat(26));assert.equal(newCui(Buffer.alloc(16,255)),'CUI-7'+'Z'.repeat(25));
 const values=new Set(Array.from({length:1000},()=>newCui()));assert.equal(values.size,1000);
 const d={cui:newCui(),fingerprint:'a'.repeat(64),secret:'b'.repeat(64)};assert.equal(validateIdentity(d,d.fingerprint),d);
 assert.throws(()=>validateIdentity(d,'c'.repeat(64)));
 assert.throws(()=>validateIdentity({...d,cui:'user-edit'},d.fingerprint));
 const h=signedDeviceHeaders(d,'cert','POST','/v1/chat/completions',1700000000000,'1'.repeat(32));
 assert.notEqual(h['X-Cude-Mac'],signedDeviceHeaders(d,'cert','GET','/v1/quota',1700000000000,'1'.repeat(32))['X-Cude-Mac']);
});
test('Windows CurrentUser DPAPI roundtrip and ciphertext tampering',{skip:process.platform!=='win32'},async t=>{
 const value=Buffer.from('CUI-device-private-secret').toString('base64');let encrypted;
 try{encrypted=await dpapi(value,true);}catch(e){if(e.code==='DPAPI_PROFILE_UNAVAILABLE'){t.skip('CurrentUser DPAPI profile unavailable in this execution environment (Windows error 2/3).');return;}throw e;}
 assert.ok(!encrypted.includes('CUI'));assert.equal(await dpapi(encrypted,false),value);
 const corrupt=Buffer.from(encrypted,'base64');corrupt[corrupt.length-1]^=255;
 await assert.rejects(dpapi(corrupt.toString('base64'),false));
});
test('mandatory/minimum policy blocks both chat and agent gates; corrupt archive never launches',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cude-mandatory-'));
 try{
  const data=Buffer.from('verified release'),file=path.join(dir,'release.zip');await fs.writeFile(file,data);
  const key=c.generateKeyPairSync('ed25519'),origin='https://release.example.test';
  const envelope=await prepare({file,url:origin+'/Cude-IDE-0.2.0-win32-x64.zip',version:'0.2.0',minimum:'0.1.0',minimumVersion:'0.2.0',mandatory:true,notes:'Test release',sequence:1,privateKey:key.privateKey.export({type:'pkcs8',format:'pem'})});
  const trust=parseReleaseTrust({feed:origin+'/release.json',key:key.publicKey.export({type:'spki',format:'pem'})});
  const {manifest}=verifyManifest(envelope,trust);
  assert.equal(requiresUpdate('0.1.0',manifest),true);assert.equal(requiresUpdate('0.2.0',manifest),false);
  assert.equal(requiresUpdate('0.1.0',{...manifest,mandatory:false,minimumVersion:'0.1.0'}),false);
  const gate=new ActivityGate();gate.block('update required');
  for(const activity of ['chat','agent'])assert.throws(()=>gate.assertAllowed(activity),/update required/);
  let launched=false;
  await assert.rejects(verifiedInstall(manifest,path.join(dir,'bad.zip'),AbortSignal.timeout(5000),async()=>{launched=true;},async()=>new Response('corrupt')));
  assert.equal(launched,false);
  await verifiedInstall(manifest,path.join(dir,'good.zip'),AbortSignal.timeout(5000),async()=>{launched=true;},async()=>new Response(data));
  assert.equal(launched,true);
  assert.throws(()=>verifyManifest({...envelope,manifest:{...manifest,mandatory:false}},trust),/signature/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('signed extension inventory rejects changed, added and missing executable files',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cude-integrity-'));
 try{
  await fs.mkdir(path.join(dir,'out'));await fs.writeFile(path.join(dir,'out','extension.js'),'safe');
  const key=c.generateKeyPairSync('ed25519'),manifest={version:'0.1.0',files:{'out/extension.js':c.createHash('sha256').update('safe').digest('hex')}};
  await fs.writeFile(path.join(dir,'integrity.json'),JSON.stringify({manifest,signature:c.sign(null,Buffer.from(JSON.stringify(manifest)),key.privateKey).toString('base64')}));
  const pub=key.publicKey.export({type:'spki',format:'pem'});
  await verifyExtensionIntegrity(dir,pub,'0.1.0');
  await fs.writeFile(path.join(dir,'out','extra.js'),'extra');await assert.rejects(verifyExtensionIntegrity(dir,pub,'0.1.0'));await fs.unlink(path.join(dir,'out','extra.js'));
  await fs.writeFile(path.join(dir,'out','extension.js'),'changed');await assert.rejects(verifyExtensionIntegrity(dir,pub,'0.1.0'));
  await fs.unlink(path.join(dir,'out','extension.js'));await assert.rejects(verifyExtensionIntegrity(dir,pub,'0.1.0'));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
