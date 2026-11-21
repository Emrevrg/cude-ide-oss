export type PoolQuotaCount = { used: number; limit: number; unlimited?: boolean };
export type PoolAccount = { role: 'user'|'supporter'|'sponsor'|'partner'|'staff'; privileges: Record<string,string>; card: { active: boolean; type?: string; expires?: string|null } };
export function parsePoolAccount(value: unknown): PoolAccount | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (!['user','supporter','sponsor','partner','staff'].includes(String(v.role))) return;
  const privileges: Record<string,string> = {};
  if (v.privileges && typeof v.privileges === 'object') for (const [key, item] of Object.entries(v.privileges as Record<string, unknown>).slice(0, 20)) if (/^[a-z.]{1,40}$/.test(key) && typeof item === 'string' && item.length <= 20) privileges[key] = item;
  const card = v.card && typeof v.card === 'object' ? v.card as Record<string, unknown> : {};
  const expires = typeof card.expires === 'string' && !Number.isNaN(Date.parse(card.expires)) ? card.expires : null;
  return { role: v.role as PoolAccount['role'], privileges, card: { active: card.active === true, ...(['supporter','sponsor','staff','partner'].includes(String(card.type))?{type:String(card.type)}:{}), expires } };
}
export type PoolModelUsage = { id: string; name: string; used: number };
export type PoolQuotaView =
  | { state: 'loading' | 'disconnected' | 'accessDenied' | 'updateRequired' | 'unavailable' }
  | { state: 'ready'; device: PoolQuotaCount; nythos?: PoolQuotaCount; nythosAvailable: boolean | null;
      models?: PoolModelUsage[]; resetsAt?: string };

export function parsePoolQuota(value: unknown, nythosAvailable: boolean | null,
  poolModels: {id:string;name:string}[] = []): PoolQuotaView | undefined {
  if (!value || typeof value !== 'object' || !('device' in value)) return;
  const parseCount = (input: unknown): PoolQuotaCount | undefined => {
    if (!input || typeof input !== 'object' || !('used' in input) || !('limit' in input)) return;
    const { used, limit } = input;
    if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0 ||
      typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) return;
    return 'unlimited' in input && input.unlimited === true ? { used, limit, unlimited: true } : { used, limit };
  };
  const device = parseCount(value.device);
  if (!device) return;
  const nythos = nythosAvailable && 'nythos' in value ? parseCount(value.nythos) : undefined;
  if (nythosAvailable && !nythos) return;
  const counts = 'models' in value && value.models && typeof value.models === 'object' ? value.models as Record<string, unknown> : {};
  const models = poolModels.slice(0, 100).map(model => {
    const used = counts[model.id];
    return { id: model.id, name: model.name || model.id, used: typeof used === 'number' && Number.isSafeInteger(used) && used >= 0 ? used : 0 };
  });
  const reset = 'resetsAt' in value && typeof value.resetsAt === 'string' && !Number.isNaN(Date.parse(value.resetsAt)) ? value.resetsAt : undefined;
  return { state: 'ready', device, nythos, nythosAvailable, ...(models.length ? { models } : {}), ...(reset ? { resetsAt: reset } : {}) };
}

type PoolQuotaFetch = (url:string, options:{
  headers:{Authorization:string}; redirect:'error'; signal:AbortSignal
})=>Promise<{
  ok:boolean; status:number; body?: {cancel():Promise<void>}|null; json():Promise<unknown>
}>;

export async function fetchPoolQuota(
  fetcher: PoolQuotaFetch, url: string, headers: {Authorization:string},
  signal: AbortSignal, nythosAvailable: boolean | null, poolModels: {id:string;name:string}[] = []
): Promise<PoolQuotaView> {
  const response = await fetcher(url+'/v1/quota', {
    headers,
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)])
  });
  if (!response.ok) {
    await response.body?.cancel().catch(()=>{});
    return {state:response.status===426?'updateRequired':[401,403].includes(response.status)?'accessDenied':'unavailable'};
  }
  return parsePoolQuota(await response.json(),nythosAvailable,poolModels)||{state:'unavailable'};
}
