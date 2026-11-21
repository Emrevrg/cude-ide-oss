import type * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {deviceFetch} from './deviceTransport';
import {readReleaseTrust} from './releaseTrust';
import {verifyExtensionIntegrity} from './extensionIntegrity';
import {heartbeatBody} from './heartbeatWire';
import {heartbeatUpdateState} from './forcedUpdate';
type Connection={url:string;headers:Record<string,string>};
let stop:(()=>Promise<void>)|undefined;
// Reads only the installed extension package. Never reads workspace/editor/chat APIs.
export async function packageStatus(context:vscode.ExtensionContext):Promise<{integrity:'ok'|'failed'|'unsigned';hash:string}>{
 try{
  const trust=await readReleaseTrust(context);
  if(!trust)return {integrity:'unsigned',hash:''};
  const envelope=JSON.parse(await fs.readFile(path.join(context.extensionPath,'integrity.json'),'utf8'));
  const hash=createHash('sha256').update(JSON.stringify(envelope.manifest)).digest('hex');
  try{await verifyExtensionIntegrity(context.extensionPath,trust.key,String(context.extension.packageJSON.version));return {integrity:'ok',hash};}
  catch{return {integrity:'failed',hash};}
 }catch{return {integrity:'failed',hash:''};}
}
export function startHeartbeat(context:vscode.ExtensionContext,request:(url:any,init?:any)=>Promise<any>,connection:()=>Promise<Connection|undefined>){
 let closed=false,busy:Promise<void>|undefined,last:Connection|undefined;
 const send=async()=>{if(closed)return;const pool=await connection();if(!pool||closed){last=undefined;return;}
  const status=await packageStatus(context);if(closed)return;
  const body=JSON.stringify(heartbeatBody(String(context.extension.packageJSON.version),status.integrity,heartbeatUpdateState()));
  const response=await deviceFetch(context,request,pool.url+'/v1/devices/heartbeat',{method:'POST',headers:{...pool.headers,'content-type':'application/json','X-Cude-Manifest-Hash':status.hash},body,signal:AbortSignal.timeout(15000)});
  if(response.ok)last=pool;await response.body?.cancel();
 };
 const tick=()=>{if(!busy&&!closed)busy=send().catch(()=>{}).finally(()=>{busy=undefined;});};
 const timer=setInterval(tick,120000);timer.unref();tick();
 const shutdown=async()=>{if(closed)return;closed=true;clearInterval(timer);await busy;
  const pool=await connection().catch(()=>undefined);if(!last||!pool||pool.url!==last.url||pool.headers.Authorization!==last.headers.Authorization)return;
  try{const response=await deviceFetch(context,request,pool.url+'/v1/devices/offline',{method:'POST',headers:{...pool.headers,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000)});await response.body?.cancel();}catch{}
 };
 stop=shutdown;context.subscriptions.push({dispose:()=>{void shutdown();}});
}
export async function stopHeartbeat(){await stop?.();stop=undefined;}
