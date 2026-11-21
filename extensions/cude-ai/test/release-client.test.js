'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {generateKeyPairSync}=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {prepare}=require('../../../build/release-manifest');
const {parseReleaseTrust,fetchSignedRelease,downloadSignedRelease}=require('../out/releaseClient');

test('IDE checks an operator-signed update, remembers sequence, and saves only verified archives',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cude-update-'));
  try{
    const origin='https://release.example.test';
    const old=path.join(dir,'fixture.zip'),target=path.join(dir,'update.zip');
    const data=Buffer.from('verified archive bytes');
    fs.writeFileSync(old,data);
    const key=generateKeyPairSync('ed25519');
    const privateKey=key.privateKey.export({format:'pem',type:'pkcs8'});
    const trust=parseReleaseTrust({feed:origin+'/release.json',key:key.publicKey.export({format:'pem',type:'spki'})});
    const envelope=await prepare({file:old,url:origin+'/Cude-IDE-0.2.0-win32-x64.zip',version:'0.2.0',minimum:'0.1.0',sequence:8,privateKey});
    const controller=new AbortController();
    const feed=async(url,options)=>{
      assert.equal(url,trust.feed);
      assert.equal(options.redirect,'error');
      return Response.json(envelope);
    };
    const next=await fetchSignedRelease(trust,undefined,controller.signal,feed);
    assert.equal(next.manifest.version,'0.2.0');
    await assert.rejects(fetchSignedRelease(trust,{...next.checkpoint,sequence:9},controller.signal,feed),/Older/);
    await assert.rejects(fetchSignedRelease(trust,{...next.checkpoint,manifestHash:'0'.repeat(64)},controller.signal,feed),/conflicting/);
    const archive=async(url,options)=>{
      assert.equal(url,next.manifest.url);
      assert.equal(options.redirect,'error');
      return new Response(new ReadableStream({start(stream){stream.enqueue(data.subarray(0,8));stream.enqueue(data.subarray(8));stream.close();}}));
    };
    await assert.rejects(downloadSignedRelease(next.manifest,target,controller.signal,async()=>new Response('wrong')),/digest/);
    assert.equal(fs.existsSync(target),false);
    await downloadSignedRelease(next.manifest,target,controller.signal,archive);
    assert.deepEqual(fs.readFileSync(target),data);
    await assert.rejects(downloadSignedRelease(next.manifest,target,controller.signal,archive),/EEXIST/);
    assert.deepEqual(fs.readdirSync(dir).sort(),['fixture.zip','update.zip']);
  }finally{fs.rmSync(dir,{recursive:true,force:true,maxRetries:3});}
});

test('a signed manifest that is not newer than the installed build is accepted even if its archive is elsewhere',()=>{
  const {generateKeyPairSync,sign}=require('node:crypto');
  const {verifyManifest}=require('../out/releaseClient.js');
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const trust={feed:'https://emrevrg.github.io/cude-ide-releases/update/manifest.json',key:publicKey.export({type:'spki',format:'pem'}),fingerprint:'x'};
  const now=Date.now();
  const manifest={schema:1,platform:'win32-x64',version:'0.1.0',minPoolVersion:'0.1.0',sequence:1,url:'https://github.com/Emrevrg/cude-ide-releases/releases/download/v0.1.0/Cude-IDE-0.1.0-win32-x64.zip',size:10,sha256:'0'.repeat(64),issuedAt:now,expiresAt:now+86400000,minimumVersion:'0.1.0',mandatory:false,notes:''};
  const envelope={manifest,signature:sign(null,Buffer.from(JSON.stringify(manifest)),privateKey).toString('base64')};
  assert.equal(verifyManifest(envelope,trust,undefined,now,'0.1.0').manifest.version,'0.1.0');
  assert.throws(()=>verifyManifest(envelope,trust,undefined,now,'0.0.9'),/archive URL/);
  assert.throws(()=>verifyManifest(envelope,trust,undefined,now),/archive URL/);
});
