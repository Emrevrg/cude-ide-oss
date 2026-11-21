import {randomBytes} from 'node:crypto';
// A capability belongs to one view and is consumed exactly once, including rejection.
export class CommandApprovals {
 private pending=new Map<string,{owner:object;finish:(allowed:boolean)=>void}>();
 request(owner:object,send:(id:string)=>void,timeout=300000,signal?:AbortSignal):Promise<boolean>{
  if(signal?.aborted)return Promise.resolve(false);
  return new Promise(resolve=>{
   const id=randomBytes(32).toString('hex');
   const finish=(allowed:boolean)=>{if(!this.pending.delete(id))return;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(allowed);};
   const abort=()=>finish(false),timer=setTimeout(abort,timeout);timer.unref();
   this.pending.set(id,{owner,finish});signal?.addEventListener('abort',abort,{once:true});
   try{send(id);}catch{finish(false);}
  });
 }
 answer(owner:object,id:unknown,allowed:unknown){if(typeof id!=='string')return false;const entry=this.pending.get(id);if(!entry||entry.owner!==owner)return false;entry.finish(allowed===true);return true;}
 cancel(owner:object){for(const entry of this.pending.values())if(entry.owner===owner)entry.finish(false);}
}
