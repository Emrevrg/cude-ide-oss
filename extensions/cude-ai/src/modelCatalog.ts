import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as vscode from 'vscode';

export type ModelRecord={id:string;providerId:string;provider:string;modelId:string;name:string;description?:string;baseUrl?:string;category:string;contextLength:number;outputLimit:number;promptCost:number;completionCost:number;pricingKnown?:boolean;free?:boolean;toolCall:boolean;vision:boolean;reasoning:boolean;modalities?:{input?:string[];output?:string[]};openWeights?:boolean;source:string};
export type ProviderRecord={id:string;name:string;api:string;doc?:string;env?:string[];category:string;source:string;modelCount:number};
export type ModelCatalogSnapshot={schemaVersion:number;updatedAt:string;sources:Record<string,{providers:number;models:number;url:string}>;providers:ProviderRecord[];models:ModelRecord[]};
const MODELS_URL='https://models.dev/api.json?type=all';
const OPENROUTER_URL='https://openrouter.ai/api/v1/models';
const category=(id:string,name:string,api:string)=>/localhost|127\.0\.0\.1/i.test(api)?'Local':/(router|gateway|litellm|portkey|openrouter)/i.test(`${id} ${name}`)?'Gateway':/(azure|vertex|bedrock|enterprise)/i.test(`${id} ${name}`)?'Enterprise':'Cloud';
async function json(url:string){const response=await fetch(url,{headers:{'user-agent':'Cude-IDE/0.1.0 model catalog'},signal:AbortSignal.timeout(45000)});if(!response.ok)throw new Error(`${new URL(url).host} returned HTTP ${response.status}`);return response.json();}
export function normalizeCatalog(modelsDev:any,openrouter:any):ModelCatalogSnapshot{
  const providers:ProviderRecord[]=[],models:ModelRecord[]=[];
  for(const [id,provider] of Object.entries<any>(modelsDev||{})){
    const api=typeof provider.api==='string'?provider.api:'',entries=Object.entries<any>(provider.models||{}),group=category(id,provider.name||id,api);
    providers.push({id,name:provider.name||id,api,doc:provider.doc||'',env:Array.isArray(provider.env)?provider.env:[],category:group,source:'models.dev',modelCount:entries.length});
    for(const [key,item] of entries){const modelId=String(item.id||key),pricingKnown=Number.isFinite(Number(item.cost?.input))&&Number.isFinite(Number(item.cost?.output))&&item.cost?.input!==undefined&&item.cost?.output!==undefined,promptCost=Number(item.cost?.input)||0,completionCost=Number(item.cost?.output)||0;models.push({id:`${id}/${modelId}`,providerId:id,provider:provider.name||id,modelId,name:item.name||modelId,description:item.description||'',baseUrl:api,category:group,contextLength:Number(item.limit?.context)||0,outputLimit:Number(item.limit?.output)||0,promptCost,completionCost,pricingKnown,free:pricingKnown&&promptCost===0&&completionCost===0,toolCall:!!item.tool_call,vision:!!item.attachment||!!item.modalities?.input?.includes('image'),reasoning:!!item.reasoning,modalities:item.modalities||{},openWeights:!!item.open_weights,source:'models.dev'});}
  }
  const rows=Array.isArray(openrouter?.data)?openrouter.data:[];providers.push({id:'openrouter',name:'OpenRouter',api:'https://openrouter.ai/api/v1',doc:'https://openrouter.ai/docs/api/api-reference/models/get-models',env:['OPENROUTER_API_KEY'],category:'Gateway',source:'openrouter',modelCount:rows.length});
  for(const item of rows){const architecture=item.architecture||{},pricing=item.pricing||{},modalities={input:architecture.input_modalities||['text'],output:architecture.output_modalities||['text']},pricingKnown=pricing.prompt!==undefined&&pricing.completion!==undefined&&Number.isFinite(Number(pricing.prompt))&&Number.isFinite(Number(pricing.completion)),promptCost=Number(pricing.prompt)*1_000_000||0,completionCost=Number(pricing.completion)*1_000_000||0;models.push({id:`openrouter/${item.id}`,providerId:'openrouter',provider:'OpenRouter',modelId:item.id,name:item.name||item.id,description:item.description||'',baseUrl:'https://openrouter.ai/api/v1',category:'Gateway',contextLength:Number(item.context_length)||0,outputLimit:Number(item.top_provider?.max_completion_tokens)||0,promptCost,completionCost,pricingKnown,free:(pricingKnown&&promptCost===0&&completionCost===0)||/:free$/i.test(item.id),toolCall:(item.supported_parameters||[]).includes('tools'),vision:modalities.input.includes('image'),reasoning:(item.supported_parameters||[]).some((value:string)=>/reasoning/i.test(value)),modalities,openWeights:false,source:'openrouter'});}
  return{schemaVersion:1,updatedAt:new Date().toISOString(),sources:{'models.dev':{providers:Object.keys(modelsDev||{}).length,models:models.filter(model=>model.source==='models.dev').length,url:MODELS_URL},openrouter:{providers:1,models:rows.length,url:OPENROUTER_URL}},providers,models};
}
export class ModelCatalog{
  private snapshot?:ModelCatalogSnapshot;
  private userSnapshot:string;
  constructor(private context:vscode.ExtensionContext){this.userSnapshot=path.join(context.globalStorageUri.fsPath,'model-catalog.json');}
  get current(){return this.snapshot;}
  async load(){
    const bundled=path.join(this.context.extensionPath,'data','model-catalog.json');
    for(const file of [this.userSnapshot,bundled])try{const parsed=JSON.parse(await fs.readFile(file,'utf8')) as ModelCatalogSnapshot;if(parsed.schemaVersion===1&&Array.isArray(parsed.models)&&Array.isArray(parsed.providers)){this.snapshot=parsed;return parsed;}}catch{}
    throw new Error('The offline model catalog is missing or invalid. Restore data/model-catalog.json and retry.');
  }
  async refresh(){const [modelsDev,openrouter]=await Promise.all([json(MODELS_URL),json(OPENROUTER_URL)]);const next=normalizeCatalog(modelsDev,openrouter);await fs.mkdir(path.dirname(this.userSnapshot),{recursive:true});const temp=this.userSnapshot+'.tmp';await fs.writeFile(temp,JSON.stringify(next),'utf8');await fs.rename(temp,this.userSnapshot);this.snapshot=next;return next;}
  snapshotOrLoad(){return this.snapshot?Promise.resolve(this.snapshot):this.load();}
}
