import {createHash,createHmac} from 'node:crypto';
import type {DeviceIdentity} from './deviceId';
export function heartbeatBody(appVersion:string,integrity:'ok'|'failed'|'unsigned',updateState:'current'|'available'|'required'){
 return {appVersion,integrity,updateState};
}
export function signPresence(identity:DeviceIdentity,method:string,url:string,headers:Headers,body:string){
 const payload=[method,url,headers.get('x-cude-timestamp'),headers.get('x-cude-nonce'),createHash('sha256').update(body).digest('hex'),headers.get('x-cude-manifest-hash')||''].join('\n');
 return createHmac('sha256',Buffer.from(identity.secret,'hex')).update(payload).digest('hex');
}
export function firewallMessage(code:unknown,language:string){
 if(!['region_blocked','network_blocked','device_blocked'].includes(String(code)))return undefined;
 return language==='tr'?'Bu konumdan/ağdan erişim kapalı.':'Access from this location/network is disabled.';
}
