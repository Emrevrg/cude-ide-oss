import type * as vscode from 'vscode';
import {createHash} from 'node:crypto';
import * as os from 'node:os';
import {getDevice,signedDeviceHeaders} from './deviceId';
import {observeUpgradeResponse} from './forcedUpdate';
import {signPresence} from './heartbeatWire';
import {observeFirewallResponse} from './firewallResponse';
const certificates=new Map<string,Promise<string>>();
export async function deviceFetch(context:vscode.ExtensionContext,request:(url:any,init?:any)=>Promise<any>,url:any,init:any={}):Promise<any>{
 const target=new URL(String(url)),headers=new Headers(init.headers),authorization=headers.get('authorization');
 if(!target.pathname.startsWith('/v1/')||!authorization?.startsWith('Bearer cude_'))return request(url,init);
 if(target.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(target.hostname))throw Error('Cihaz kaydı HTTPS gerektirir.');
 const identity=await getDevice(context),appVersion=String(context.extension.packageJSON.version);
 const cache=target.origin+createHash('sha256').update(authorization).digest('hex');
 const register=async()=>{
  const response=await request(target.origin+'/v1/devices/register',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization,'content-type':'application/json','X-Cude-Client-Version':appVersion},
   body:JSON.stringify({...identity,appVersion,osVersion:os.release()})});
  if(!response.ok){await observeFirewallResponse(response);await observeUpgradeResponse(response);await response.body?.cancel();throw Error('Cihaz kaydı reddedildi. Operatöre başvurun.');}
  const body=await response.json();if(typeof body.certificate!=='string'||body.certificate.length>2048)throw Error('Geçersiz cihaz sertifikası.');return body.certificate;
 };
 if(!certificates.has(cache)){const promise=register().catch(e=>{certificates.delete(cache);throw e;});certificates.set(cache,promise);}
 const certificate=await certificates.get(cache)!;
 Object.entries(signedDeviceHeaders(identity,certificate,init.method||'GET',target.pathname+target.search)).forEach(([key,value])=>headers.set(key,value));
 headers.set('X-Cude-Client-Version',appVersion);headers.set('X-Cude-OS-Version',os.release());
 if(['/v1/devices/heartbeat','/v1/devices/offline'].includes(target.pathname))headers.set('X-Cude-Presence-Mac',signPresence(identity,init.method||'GET',target.pathname+target.search,headers,String(init.body||'')));
 const response=await request(url,{...init,headers:Object.fromEntries(headers.entries()),redirect:'error'});
 await observeUpgradeResponse(response);
 if(response.status===401||response.status===403)certificates.delete(cache);
 await observeFirewallResponse(response);
 return response;
}
