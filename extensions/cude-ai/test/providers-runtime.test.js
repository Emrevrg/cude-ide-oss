const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const {I18N}=require('../out/i18n.js');
const {FREE_PROVIDERS}=require('../out/freeModels.js');
const {recommendedLocalModels}=require('../out/localModels.js');

class ElementMock{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.style={};this.value='';this.textContent='';this.placeholder='';this.className='';this.classList={toggle(){}};this.hidden=false;this.checked=false;this.attributes={};this.handlers={};}
  replaceChildren(...children){this.children=[...children];}
  append(...children){this.children.push(...children);}
  appendChild(child){this.children.push(child);return child;}
  add(child){this.children.push(child);}
  addEventListener(name,handler){(this.handlers[name]??=[]).push(handler);}
  setAttribute(name,value){this.attributes[name]=String(value);}
  querySelector(selector){const tag=selector.toUpperCase();return this.children.find(child=>child.tagName===tag)||null;}
  click(){this.onclick?.({stopPropagation(){}});for(const handler of this.handlers.click||[])handler({stopPropagation(){}});}
}
class OptionMock extends ElementMock{constructor(text,value){super('option');this.textContent=text;this.value=value;}}

test('providers webview script executes, isolates section faults, and retains all rendered sections',()=>{
  const file=path.join(root,'media','providers.html');let html=fs.readFileSync(file,'utf8');
  const device={ram:12*1024**3,vram:2*1024**3,cores:8,gpu:'GeForce 940MX',usable:12*1024**3,directory:'E:/CudeModels'};
  const localModels=[{name:'Qwen2.5-Coder-0.5B-Instruct-GGUF.gguf',path:'E:/CudeModels/Qwen2.5-Coder-0.5B-Instruct-GGUF.gguf',size:491400064,license:'apache-2.0'}];
  const presets=[{id:'openai',name:'OpenAI',provider:'openai',baseUrl:'https://api.openai.com/v1',category:'Cloud'}];
  const values={NONCE:'runtime-test',PRESETS:JSON.stringify(presets),PROFILES:'[]',LOCAL_AGENTS:'[]',LOCAL_MODELS:JSON.stringify(localModels),FREE_PROVIDERS:JSON.stringify(FREE_PROVIDERS),RECOMMENDED_MODELS:JSON.stringify(recommendedLocalModels({usableBytes:device.usable,gpu:device.gpu})),DEVICE:JSON.stringify(device),CATALOG:JSON.stringify({models:10548,providers:327,freeModels:65,freeOnly:false,requestUsage:0,requestLimit:200}),ACTIVE:'""',LANG:'en',CLI_ENABLED:'false',ICONS:'{}',FOCUS:'""',POOL_URL:'""',I18N:JSON.stringify(I18N)};
  for(const [key,value] of Object.entries(values))html=html.replaceAll(`{{${key}}}`,value);
  const script=html.match(/<script nonce="runtime-test">([\s\S]*?)<\/script>/)?.[1];assert.ok(script,'provider script exists');
  const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,new ElementMock());return elements.get(id);};const sent=[],windowEvents={};
  const document={getElementById:get,createElement:tag=>new ElementMock(tag),querySelectorAll:()=>[],body:new ElementMock('body'),documentElement:new ElementMock('html')};
  const context={document,window:{addEventListener:(name,fn)=>{(windowEvents[name]??=[]).push(fn);}},acquireVsCodeApi:()=>({postMessage:message=>sent.push(message),getState:()=>({}),setState(){}}),Option:OptionMock,console:{error(){}},setTimeout:()=>1,clearTimeout(){},URL,Date,Map,Set,Math,Number,String,Object,Array,Promise};
  vm.runInNewContext(`${script}\nthis.__safeSection=safeSection;`,context,{timeout:2000});
  assert.equal(get('freeProviders').children.length,FREE_PROVIDERS.length);
  assert.equal(get('recommendedModels').children.length,8);
  const recommended = id => get('recommendedModels').children.find(card => card.dataset.repo === id);
  assert.match(recommended('emrevrg/Norovox-N1-7B-GGUF').children[2].textContent,/4\.36 GiB/);
  assert.match(recommended('emrevrg/Norovox-N1-1.5B-GGUF').children[2].textContent,/1\.04 GiB/);
  assert.equal(get('downloadedModels').children.length,1);
  assert.ok(sent.some(message=>message.type==='searchLocalModels'&&message.query==='Qwen 0.5B'));
  assert.doesNotThrow(()=>context.__safeSection('freeProviders',()=>{throw new Error('injected render defect');}));
  assert.equal(get('freeProviders').children.length,1);
  assert.match(get('freeProviders').children[0].textContent,/freeProviders/);
  const messageHandler=windowEvents.message[0];assert.ok(messageHandler);
  assert.ok(sent.some(message=>message.type==='refreshPoolQuota'));
  assert.match(get('freeUsage').textContent,/0.*200/);
  messageHandler({data:{type:'poolQuota',quota:{state:'ready',device:{used:12,limit:80},nythos:{used:2,limit:25},nythosAvailable:true}}});
  assert.match(get('poolQuotaTotal').textContent,/12.*80.*68/);
  assert.match(get('poolQuotaNythos').textContent,/2.*25.*23/);
  messageHandler({data:{type:'poolQuota',quota:{state:'ready',device:{used:81,limit:80},nythosAvailable:false}}});
  assert.match(get('poolQuotaTotal').textContent,/81.*80.*0/);
  assert.match(get('poolQuotaNythos').textContent,/not available/);
  messageHandler({data:{type:'poolQuota',quota:{state:'accessDenied'}}});
  assert.match(get('poolQuotaTotal').textContent,/denied/);
  assert.equal(get('poolQuotaNythos').textContent,'');
  get('chooseTheme').click();
  assert.ok(sent.some(message=>message.type==='chooseTheme'));
  get('openAcp').click();
  assert.match(get('status').textContent,/Turn on CLI integration first/);

  messageHandler({data:{type:'localSearchResults',requestId:'1',models:[{id:'Qwen/Qwen2.5-0.5B-Instruct-GGUF',license:'apache-2.0',downloads:4,files:[],detailsPending:true}],device}});
  assert.equal(get('hfResults').children.length,1);
  assert.equal(get('hfResults').children[0].children.at(-1).children[0].textContent,'View downloadable files');
  messageHandler({data:{type:'localModelDetails',model:{id:'Qwen/Qwen3-4B-GGUF',description:'Qwen3 model',files:[{name:'Qwen3.gguf',fits:true,size:1}]}}});
  assert.equal(recommended('Qwen/Qwen3-4B-GGUF').querySelector('select').children[0].textContent.startsWith('Qwen3.gguf'),true);
  get('key').value='unsaved-key';
  messageHandler({data:{type:'language',language:'tr'}});
  assert.equal(document.documentElement.lang,'tr');
  assert.equal(get('languageSelect').value,'tr');
  assert.equal(get('key').value,'unsaved-key');
  assert.equal(get('cliStatusLine').textContent,I18N.tr['cli.off']);
});
