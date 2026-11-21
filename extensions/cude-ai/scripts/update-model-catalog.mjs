import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'data','model-catalog.json');
const get=async(url)=>{const response=await fetch(url,{headers:{'user-agent':'Cude-IDE/0.1.0 model catalog updater'},signal:AbortSignal.timeout(45000)});if(!response.ok)throw new Error(`${url}: HTTP ${response.status}`);return response.json();};
const [modelsDev,openrouter]=await Promise.all([get('https://models.dev/api.json?type=all'),get('https://openrouter.ai/api/v1/models')]);
const providers=[];const models=[];
for(const [id,provider] of Object.entries(modelsDev)){
  const api=typeof provider.api==='string'?provider.api:'';const modelEntries=Object.entries(provider.models||{});const category=/localhost|127\.0\.0\.1/i.test(api)?'Local':/(router|gateway|litellm|portkey|openrouter)/i.test(`${id} ${provider.name}`)?'Gateway':/(azure|vertex|bedrock|enterprise)/i.test(`${id} ${provider.name}`)?'Enterprise':'Cloud';
  providers.push({id,name:provider.name||id,api,doc:provider.doc||'',env:Array.isArray(provider.env)?provider.env:[],category,source:'models.dev',modelCount:modelEntries.length});
  for(const [key,item] of modelEntries){const modelId=String(item.id||key);models.push({id:`${id}/${modelId}`,providerId:id,provider:provider.name||id,modelId,name:item.name||modelId,description:item.description||'',baseUrl:api,category,contextLength:Number(item.limit?.context)||0,outputLimit:Number(item.limit?.output)||0,promptCost:Number(item.cost?.input)||0,completionCost:Number(item.cost?.output)||0,toolCall:!!item.tool_call,vision:!!item.attachment||!!item.modalities?.input?.includes('image'),reasoning:!!item.reasoning,modalities:item.modalities||{},openWeights:!!item.open_weights,source:'models.dev'});}
}
const openRouterRows=Array.isArray(openrouter.data)?openrouter.data:[];
providers.push({id:'openrouter',name:'OpenRouter',api:'https://openrouter.ai/api/v1',doc:'https://openrouter.ai/docs/api/api-reference/models/get-models',env:['OPENROUTER_API_KEY'],category:'Gateway',source:'openrouter',modelCount:openRouterRows.length});
for(const item of openRouterRows){const architecture=item.architecture||{},pricing=item.pricing||{},modalities={input:architecture.input_modalities||['text'],output:architecture.output_modalities||['text']};models.push({id:`openrouter/${item.id}`,providerId:'openrouter',provider:'OpenRouter',modelId:item.id,name:item.name||item.id,description:item.description||'',baseUrl:'https://openrouter.ai/api/v1',category:'Gateway',contextLength:Number(item.context_length)||0,outputLimit:Number(item.top_provider?.max_completion_tokens)||0,promptCost:(Number(pricing.prompt)||0)*1_000_000,completionCost:(Number(pricing.completion)||0)*1_000_000,toolCall:(item.supported_parameters||[]).includes('tools'),vision:modalities.input.includes('image'),reasoning:(item.supported_parameters||[]).some(value=>/reasoning/i.test(value)),modalities,openWeights:false,source:'openrouter'});}
const result={schemaVersion:1,updatedAt:new Date().toISOString(),sources:{'models.dev':{providers:Object.keys(modelsDev).length,models:models.filter(item=>item.source==='models.dev').length,url:'https://models.dev/api.json?type=all'},openrouter:{providers:1,models:openRouterRows.length,url:'https://openrouter.ai/api/v1/models'}},providers,models};
await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result),'utf8');
console.log(JSON.stringify({output,providers:providers.length,models:models.length,updatedAt:result.updatedAt,bytes:Buffer.byteLength(JSON.stringify(result))},null,2));
