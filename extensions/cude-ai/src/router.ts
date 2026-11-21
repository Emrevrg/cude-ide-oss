import type { ModelRecord } from './modelCatalog';

export type RoutePreference='quality'|'speed'|'cost';
export type RouteKind='completion'|'edit'|'review'|'agent'|'vision'|'long-context'|'chat';
export type RouteCandidate={providerId:string;provider:string;model:string;metadata?:ModelRecord;latencyMs?:number;free?:boolean};
export function isFallbackError(error:unknown){const message=error instanceof Error?error.message:String(error);return /(?:\b429\b|too[_ -]?many[_ -]?requests|quota|rate limit|capacity|temporarily unavailable)/i.test(message);}
export async function withFallback<T>(candidates:RouteCandidate[],attempt:(candidate:RouteCandidate)=>Promise<T>,retryable:(error:unknown)=>boolean){let last:unknown;for(const candidate of candidates){try{return{candidate,value:await attempt(candidate)};}catch(error){last=error;if(!retryable(error))throw error;}}throw last instanceof Error?last:new Error('No model route succeeded.');}
export function classifyTask(prompt:string):RouteKind{
  const text=prompt.toLowerCase();if(/<\|fim_prefix\|>|inline completion|complete only the code/.test(text))return 'completion';if(/review this git diff|code review|review changes/.test(text))return 'review';if(/image_url|inline_data|image understanding|image:/.test(text))return 'vision';if(/long context|entire repository|whole codebase|large context/.test(text))return 'long-context';if(/subagent|parallel review|agent task|implement the task/.test(text))return 'agent';if(/edit only|complete replacement|modify the selected/.test(text))return 'edit';return 'chat';
}
export function chooseRoute(candidates:RouteCandidate[],preference:RoutePreference,kind:RouteKind,allowed:string[]=[],contextNeed=0){
  const pool=candidates.filter(item=>(!allowed.length||allowed.includes(item.providerId))&&item.model.trim());if(!pool.length)return undefined;
  const score=(candidate:RouteCandidate)=>{const m=candidate.metadata,cost=(m?.promptCost||0)+(m?.completionCost||0),ctx=m?.contextLength||0;let value=0;
    if(preference==='cost')value-=cost*1000;else if(preference==='speed')value-=(candidate.latencyMs??(m?.openWeights?700:1200));else value+=Math.min(ctx,1000000)/10000+(m?.reasoning?8:0)+(m?.toolCall?5:0);
    if(kind==='completion'){value+=m?.openWeights?8:0;value-=cost*400;value+=ctx?Math.max(0,50-ctx/10000):0;}
    if(kind==='review'||kind==='edit'||kind==='agent'){value+=m?.toolCall?12:0;value+=m?.reasoning?8:0;}
    if(kind==='vision')value+=m?.vision?100:-10000;
    if(kind==='long-context')value+=Math.min(ctx,2000000)/1000;
    if(contextNeed&&ctx&&ctx<contextNeed)value-=100000;
    return value;
  };
  return [...pool].sort((a,b)=>score(b)-score(a)||a.model.localeCompare(b.model))[0];
}
export function estimateUsage(input:string,output:string,route:RouteCandidate){const inputTokens=Math.ceil(input.length/4),outputTokens=Math.ceil(output.length/4),inputCost=(route.metadata?.promptCost||0)*inputTokens/1_000_000,outputCost=(route.metadata?.completionCost||0)*outputTokens/1_000_000;return{inputTokens,outputTokens,totalTokens:inputTokens+outputTokens,estimatedCost:inputCost+outputCost};}
