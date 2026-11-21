import {compareVersions,downloadSignedRelease,type ReleaseManifest} from './releaseClient';
export function requiresUpdate(current:string,manifest:ReleaseManifest){
 return (manifest.minimumVersion!==undefined&&compareVersions(current,manifest.minimumVersion)<0) ||
  (manifest.mandatory===true&&compareVersions(current,manifest.version)<0);
}
export class ActivityGate{
 private reason='';
 block(reason:string){this.reason=reason;}
 allow(){this.reason='';}
 assertAllowed(){if(this.reason)throw Error(this.reason);}
 get blocked(){return !!this.reason;}
}
export const activityGate=new ActivityGate();
// Launch is unreachable until both the authenticated manifest and archive hash have been checked.
export async function verifiedInstall(manifest:ReleaseManifest,target:string,signal:AbortSignal,launch:(file:string)=>Promise<void>,request=fetch,progress?:(received:number,total:number)=>void){
 await downloadSignedRelease(manifest,target,signal,request,progress);
 await launch(target);
}
