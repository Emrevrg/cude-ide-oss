import {createHash,createPublicKey,verify} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export async function verifyExtensionIntegrity(root:string,key:string,currentVersion:string){
 const envelope=JSON.parse(await fs.readFile(path.join(root,'integrity.json'),'utf8'));
 const manifest=envelope.manifest;
 if(!manifest||createPublicKey(key).asymmetricKeyType!=='ed25519'||!verify(null,Buffer.from(JSON.stringify(manifest)),key,Buffer.from(envelope.signature,'base64'))||
  manifest.version!==currentVersion||!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files))throw Error('Cude IDE’yi yeniden kurun: bütünlük imzası geçersiz.');
 const actual=(await fs.readdir(path.join(root,'out'))).filter(name=>name.endsWith('.js')).sort();
 const names=Object.keys(manifest.files).sort();
 if(JSON.stringify(actual.map(n=>'out/'+n))!==JSON.stringify(names))throw Error('Cude IDE’yi yeniden kurun: dosya listesi değişmiş.');
 for(const name of names){
  if(!/^out\/[a-zA-Z0-9_-]+\.js$/.test(name)||!/^[a-f0-9]{64}$/.test(manifest.files[name]))throw Error('Geçersiz bütünlük listesi.');
  const stat=await fs.lstat(path.join(root,name));if(!stat.isFile()||stat.isSymbolicLink())throw Error('Geçersiz eklenti dosyası.');
  if(createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex')!==manifest.files[name])throw Error('Cude IDE’yi yeniden kurun: '+name);
 }
}
