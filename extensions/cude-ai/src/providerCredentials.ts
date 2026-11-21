import { createHash } from 'node:crypto';

export type ProviderCredentials = { key:string; headers:Record<string,string>; proxy:string };
export type ProfileIdentity = { id:string; provider:string; baseUrl:string };
type SecretStore = { get(key:string):Thenable<string|undefined>; store(key:string,value:string):Thenable<void>; delete(key:string):Thenable<void> };

export function credentialSlot(profile:ProfileIdentity):string {
  const url=new URL(profile.baseUrl);
  const endpoint=url.toString().replace(/\/+$/,'');
  return 'cude-ai.provider.v2.'+createHash('sha256').update(JSON.stringify([profile.id,profile.provider,endpoint])).digest('hex');
}

export function emptyProviderCredentials():ProviderCredentials { return {key:'',headers:{},proxy:''}; }

export async function readProviderCredentials(store:SecretStore,profile?:ProfileIdentity):Promise<ProviderCredentials>{
  if(!profile)return emptyProviderCredentials();
  const raw=await store.get(credentialSlot(profile));
  if(!raw)return emptyProviderCredentials();
  try{
    const value=JSON.parse(raw);
    if(typeof value?.key!=='string'||typeof value?.proxy!=='string'||!value.headers||Array.isArray(value.headers)||typeof value.headers!=='object'||
      Object.values(value.headers).some(item=>typeof item!=='string'))return emptyProviderCredentials();
    return {key:value.key,headers:value.headers,proxy:value.proxy};
  }catch{return emptyProviderCredentials();}
}

export async function writeProviderCredentials(store:SecretStore,profile:ProfileIdentity,creds:ProviderCredentials):Promise<void>{
  const slot=credentialSlot(profile);
  if(!creds.key&&!creds.proxy&&!Object.keys(creds.headers).length){await store.delete(slot);return;}
  await store.store(slot,JSON.stringify(creds));
}

export function mergeImportedProfiles<T extends ProfileIdentity & {name:string}>(active:T[], imports:T[], createId:()=>string):{profiles:T[];count:number}{
  const profiles=[...active],used=new Set(active.map(item=>item.id)),seen=new Set<string>();
  const signature=(item:T)=>JSON.stringify([item.name,item.provider,item.baseUrl]);
  const signatures=new Set(active.map(signature));
  for(const item of imports){
    const key=signature(item);
    if(used.has(item.id)||seen.has(item.id)||signatures.has(key))continue;
    seen.add(item.id);signatures.add(key);
    const id=createId();
    if(used.has(id))throw Error('Provider id collision.');
    used.add(id);
    profiles.push({...item,id});
  }
  return {profiles,count:profiles.length-active.length};
}
