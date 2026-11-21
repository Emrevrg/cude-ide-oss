'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const {prepare}=require('./release-manifest');
async function main(){
 const [mode,...args]=process.argv.slice(2);
 if(mode==='seal'){
  const [inventory,keyFile,output]=args,key=crypto.createPrivateKey(fs.readFileSync(keyFile));
  if(key.asymmetricKeyType!=='ed25519')throw Error('Ed25519 required');
  const manifest=JSON.parse(fs.readFileSync(inventory,'utf8'));
  fs.writeFileSync(output,JSON.stringify({manifest,signature:crypto.sign(null,Buffer.from(JSON.stringify(manifest)),key).toString('base64')}));
 }else if(mode==='publish'){
  const [file,url,version,minimum,sequence,keyFile,output,mandatory,notesFile]=args;
  const envelope=await prepare({file,url,version,minimum,sequence:Number(sequence),privateKey:fs.readFileSync(keyFile),minimumVersion:minimum,mandatory:mandatory==='true',notes:notesFile?fs.readFileSync(notesFile,'utf8'):''});
  fs.writeFileSync(output,JSON.stringify(envelope,null,2)+'\n',{flag:'wx'});
 }else if(mode==='trust'){
  const [keyFile,feed,output]=args;
  const key=crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(keyFile))).export({type:'spki',format:'pem'});
  fs.writeFileSync(output,JSON.stringify({feed,key}));
 }else throw Error('Use publish-update.ps1');
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
