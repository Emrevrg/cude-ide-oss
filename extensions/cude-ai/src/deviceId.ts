import type * as vscode from 'vscode';
import {createHash, randomBytes, createHmac} from 'node:crypto';
import {spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export type DeviceIdentity={cui:string;fingerprint:string;secret:string};
const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newCui(bytes=randomBytes(16)){
 if(bytes.length!==16)throw Error('128 bit gerekir.');
 let n=BigInt('0x'+bytes.toString('hex')), result='';
 for(let i=0;i<26;i++){result=alphabet[Number(n&31n)]+result;n>>=5n;}
 return 'CUI-'+result;
}
export function validateIdentity(value:DeviceIdentity,fingerprint:string){
 if(!value || !/^CUI-[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value.cui)||!/^[a-f0-9]{64}$/.test(value.secret)||value.fingerprint!==fingerprint)
  throw Error('Cihaz kimliği geçersiz veya parmak izi değişmiş. Yeniden kayıt için operatöre başvurun.');
 return value;
}
function powershell(script:string,input=''):Promise<string>{
 return new Promise((resolve,reject)=>{
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',size=0;const timer=setTimeout(()=>{child.kill();reject(Error('Cihaz güvenliği işlemi zaman aşımına uğradı.'));},60000);
  child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>65536)child.kill();else output+=b.toString();});
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);code===0&&size<=65536?resolve(output.trim()):reject(Object.assign(Error(code===73?'Windows DPAPI kullanıcı profili bu ortamda kullanılamıyor.':'Windows cihaz güvenliği işlemi başarısız.'),{code:code===73?'DPAPI_PROFILE_UNAVAILABLE':'DPAPI_FAILED'}));});
  child.stderr.resume();
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
export async function deviceFingerprint(){
 if(process.platform!=='win32')throw Error('Cihaz kimliği Windows DPAPI gerektirir.');
 const raw=await powershell("$ErrorActionPreference='Stop'; $m=(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid; $c=@(Get-CimInstance Win32_Processor | ForEach-Object {$_.ProcessorId}) -join ','; $d=@(Get-CimInstance Win32_DiskDrive | ForEach-Object {$_.SerialNumber}) -join ','; if(!$m -or (!$c -and !$d)){throw 'Missing hardware identity'}; [Console]::Write($m+'|'+$c+'|'+$d)");
 return createHash('sha256').update(raw).digest('hex');
}
export async function dpapi(value:string,protect:boolean){
 const operation=protect?'Protect':'Unprotect';
 return powershell("$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); try { $r=[Security.Cryptography.ProtectedData]::"+operation+"($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser) } catch { if ($_.Exception.InnerException.HResult -in @(-2147024894,-2147024893)) { exit 73 }; exit 74 }; [Console]::Write([Convert]::ToBase64String($r))",value);
}
const pending=new WeakMap<object,Promise<DeviceIdentity>>();
export function getDevice(context:Pick<vscode.ExtensionContext,'secrets'>){
 let value=pending.get(context);if(!value){value=loadDevice(context);pending.set(context,value);
  // A failed attempt (timeout, busy WMI) must not stick for the whole session.
  value.catch(()=>{if(pending.get(context)===value)pending.delete(context);});}return value;
}
async function loadDevice(context:Pick<vscode.ExtensionContext,'secrets'>){
 const slot='cude.device.dpapi.v1';
 if(!process.env.LOCALAPPDATA)throw Error('LOCALAPPDATA bulunamadı.');
 const backup=path.join(process.env.LOCALAPPDATA,'Cude','device.bin');
 const [fingerprint, { stored, disk, decrypted }] = await Promise.all([
  deviceFingerprint(),
  Promise.all([
   context.secrets.get(slot),
   fs.readFile(backup,'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;})
  ]).then(async ([secret, disk]) => {
   if(secret&&disk&&secret!==disk)throw Error('Cihaz kimliği yedeği uyuşmuyor. Yeniden kayıt gerekiyor.');
   const stored=secret||disk;
   return {stored,disk,decrypted:stored?await dpapi(stored,false):''};
  })
 ]);
 if(stored){
  const identity=validateIdentity(JSON.parse(Buffer.from(decrypted,'base64').toString('utf8')),fingerprint);
  await fs.mkdir(path.dirname(backup),{recursive:true});
  if(!disk)await fs.writeFile(backup,stored,{flag:'wx',mode:0o600});
  await context.secrets.store(slot,stored);return identity;
 }
 const identity={cui:newCui(),fingerprint,secret:randomBytes(32).toString('hex')};
 const encrypted=await dpapi(Buffer.from(JSON.stringify(identity)).toString('base64'),true);
 await fs.mkdir(path.dirname(backup),{recursive:true});
 await fs.writeFile(backup,encrypted,{flag:'wx',mode:0o600});
 await context.secrets.store(slot,encrypted);
 return identity;
}
export function signedDeviceHeaders(identity:DeviceIdentity,certificate:string,method:string,url:string,now=Date.now(),nonce=randomBytes(16).toString('hex')){
 const timestamp=String(now),digest=createHash('sha256').update(certificate).digest('hex');
 return {'X-Cude-Certificate':certificate,'X-Cude-Fingerprint':identity.fingerprint,'X-Cude-Timestamp':timestamp,'X-Cude-Nonce':nonce,
 'X-Cude-Mac':createHmac('sha256',Buffer.from(identity.secret,'hex')).update([method,url,timestamp,nonce,digest].join('\n')).digest('hex')};
}
