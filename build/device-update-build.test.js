'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),c=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function ps(file,args,env){const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,...args],{encoding:'utf8',windowsHide:true,timeout:120000,env:env||process.env});if(result.error)throw result.error;return result;}
function fixture(){
 const tempRoot=path.join(root,'.device-update-qa','build-tests');fs.mkdirSync(tempRoot,{recursive:true});
 const dir=fs.mkdtempSync(path.join(tempRoot,'case-')),source=path.join(dir,'source'),app=path.join(source,'Cude-IDE');
 fs.mkdirSync(app,{recursive:true});
 const zipper=path.join(dir,'zip.ps1');
 fs.writeFileSync(zipper,"param([string]$Source,[string]$Target)\n$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::CreateFromDirectory($Source,$Target)\n");
 return {dir,source,app,zipper};
}
test('publisher seals executable inventory and signs mandatory release archive',{skip:process.platform!=='win32'},async()=>{
 const f=fixture();
 try{
  const ext=path.join(f.app,'resources/app/extensions/cude-ai');fs.mkdirSync(path.join(ext,'out'),{recursive:true});
  fs.writeFileSync(path.join(ext,'out/extension.js'),'exports.activate=()=>{};');
  fs.writeFileSync(path.join(ext,'package.json'),JSON.stringify({version:'0.2.0'}));
  const archive=path.join(f.dir,'Cude-IDE-0.2.0-win32-x64.zip');assert.equal(ps(f.zipper,[f.source,archive]).status,0);
  const key=c.generateKeyPairSync('ed25519'),privateFile=path.join(f.dir,'private.key'),output=path.join(f.dir,'release.json');
  fs.writeFileSync(privateFile,key.privateKey.export({type:'pkcs8',format:'pem'}));
  const result=ps(path.join(root,'build/publish-update.ps1'),['-Archive',archive,'-Url','https://release.example.test/Cude-IDE-0.2.0-win32-x64.zip','-Feed','https://release.example.test/release.json','-Version','0.2.0','-MinimumVersion','0.2.0','-Sequence','2','-PrivateKey',privateFile,'-Output',output,'-Mandatory']);
  assert.equal(result.status,0,result.stdout+result.stderr);
  const envelope=JSON.parse(fs.readFileSync(output,'utf8'));
  assert.equal(envelope.manifest.mandatory,true);assert.equal(envelope.manifest.minimumVersion,'0.2.0');
  await require('./release-manifest').verify({envelope,publicKey:key.publicKey.export({type:'spki',format:'pem'}),origin:'https://release.example.test',minSequence:2,file:archive});
  const extract=path.join(f.dir,'extract.ps1'),target=path.join(f.dir,'unpacked');
  fs.writeFileSync(extract,"param($Source,$Target)\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::ExtractToDirectory($Source,$Target)\n");
  assert.equal(ps(extract,[archive,target]).status,0);
  const packed=path.join(target,'Cude-IDE/resources/app/extensions/cude-ai'),trust=JSON.parse(fs.readFileSync(path.join(packed,'release-trust.json')));
  await require('../extensions/cude-ai/out/extensionIntegrity').verifyExtensionIntegrity(packed,trust.key,'0.2.0');
 }finally{try{fs.rmSync(f.dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}catch(e){console.warn('QA fixture retained for inspection: '+f.dir+' ('+e.code+')');}}
});
test('Windows update runner preserves data and rolls back an installer launch failure',{skip:process.platform!=='win32'},()=>{
 for(const fail of [false,true]){
  const f=fixture();
  try{
   const data=path.join(f.dir,'local'),installed=path.join(data,'Programs/Cude IDE/Cude-IDE'),sentinel=Buffer.from('settings and history must survive');
   fs.mkdirSync(path.join(installed,'data/User'),{recursive:true});fs.writeFileSync(path.join(installed,'data/User/settings.json'),sentinel);fs.writeFileSync(path.join(installed,'old-binary.txt'),'old');
   if(fail)fs.writeFileSync(path.join(f.app,'CudeIDE.exe'),'invalid executable');else fs.copyFileSync(path.join(process.env.WINDIR,'System32/whoami.exe'),path.join(f.app,'CudeIDE.exe'));
   fs.mkdirSync(path.join(f.app,'data'),{recursive:true});fs.writeFileSync(path.join(f.app,'data/new-marker.txt'),'archive data');
   const archive=path.join(f.dir,'update.zip');assert.equal(ps(f.zipper,[f.source,archive]).status,0);
   const runner=path.join(f.dir,'runner.ps1');fs.writeFileSync(runner,require('../extensions/cude-ai/out/updateInstaller').UPDATE_RUNNER);
   const result=ps(runner,['-Archive',archive,'-ParentPid','99999999'],{...process.env,LOCALAPPDATA:data});
   assert.equal(result.status,fail?1:0,result.stdout+result.stderr);
   assert.deepEqual(fs.readFileSync(path.join(installed,'data/User/settings.json')),sentinel);
   if(fail)assert.equal(fs.readFileSync(path.join(installed,'old-binary.txt'),'utf8'),'old');
  }finally{try{fs.rmSync(f.dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}catch(e){console.warn('QA fixture retained for inspection: '+f.dir+' ('+e.code+')');}}
 }
});
