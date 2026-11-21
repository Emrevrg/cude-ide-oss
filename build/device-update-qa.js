'use strict';
// A separate development extension exercises the real update webview with an ephemeral test signature.
// It does not install an update or replace the user's Cude extension/identity.
const fs=require('node:fs'),path=require('node:path'),c=require('node:crypto'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),qa=path.join(root,'.device-update-qa'),fixture=path.join(qa,'fixture');
fs.mkdirSync(path.join(qa,'portable'),{recursive:true});fs.mkdirSync(path.join(fixture,'out'),{recursive:true});fs.mkdirSync(path.join(root,'screenshots'),{recursive:true});
const key=c.generateKeyPairSync('ed25519');
const feed='https://device-update.invalid/release.json';
const manifest={schema:1,platform:'win32-x64',version:'0.2.0',minPoolVersion:'0.1.0',minimumVersion:'0.2.0',mandatory:true,sequence:1,url:'https://device-update.invalid/Cude-IDE-0.2.0-win32-x64.zip',size:1,sha256:c.createHash('sha256').update('x').digest('hex'),issuedAt:Date.now(),expiresAt:Date.now()+86400000,notes:'Görsel kabul denemesi. Test imzası ve test cihazı kullanılıyor; kurulum başlatılmadı.'};
const envelope={manifest,signature:c.sign(null,Buffer.from(JSON.stringify(manifest)),key.privateKey).toString('base64')};
const source=`const vscode=require('vscode');
const fs=require('node:fs');
exports.activate=async context=>{
 const device=require(${JSON.stringify(path.join(root,'extensions/cude-ai/out/deviceId'))});
 device.getDevice=async()=>({cui:'CUI-00000000000000000000000000',fingerprint:'a'.repeat(64),secret:'b'.repeat(64)});
 const update=require(${JSON.stringify(path.join(root,'extensions/cude-ai/out/forcedUpdate'))});
 const state=new Map();
 const fixtureContext={...context,extensionPath:${JSON.stringify(fixture)},extensionMode:2,extension:{packageJSON:{version:'0.1.0'}},globalState:{get:(key,fallback)=>state.get(key)??fallback,update:async(key,value)=>{state.set(key,value);}}};
 global.fetch=async url=>{if(String(url)!==${JSON.stringify(feed)})throw Error('QA does not download installers');return Response.json(${JSON.stringify(envelope)});};
 update.initializeForcedUpdate(fixtureContext);
 try{await update.assertActivityAllowed();throw Error('QA expected activity gate to block');}catch(e){fs.writeFileSync(${JSON.stringify(path.join(qa,'gate-result.txt'))},e.message);}
};
`;
fs.writeFileSync(path.join(fixture,'out/extension.js'),source);
fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'cude-forced-update-qa',publisher:'cude-test',version:'0.1.0',engines:{vscode:'^1.90.0'},main:'./out/extension.js',activationEvents:['onStartupFinished']}));
fs.writeFileSync(path.join(fixture,'release-trust.json'),JSON.stringify({feed,key:key.publicKey.export({type:'spki',format:'pem'})}));
const integrity={version:'0.1.0',files:{'out/extension.js':c.createHash('sha256').update(source).digest('hex')}};
fs.writeFileSync(path.join(fixture,'integrity.json'),JSON.stringify({manifest:integrity,signature:c.sign(null,Buffer.from(JSON.stringify(integrity)),key.privateKey).toString('base64')}));
console.log('QA fixture: '+fixture);
if(process.argv.includes('--launch')){
 const executable=path.join(process.env.LOCALAPPDATA,'Programs/Cude IDE/Cude-IDE/CudeIDE.exe');
 const child=spawn(executable,['--new-window','--disable-extension=cude.cude-ai','--skip-welcome','--skip-release-notes','--user-data-dir='+path.join(qa,'user'),'--extensions-dir='+path.join(qa,'extensions'),'--extensionDevelopmentPath='+fixture],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:'',VSCODE_PORTABLE:path.join(qa,'portable')}});
 child.once('error',e=>{console.error(e.message);process.exitCode=1;});child.unref();
}
