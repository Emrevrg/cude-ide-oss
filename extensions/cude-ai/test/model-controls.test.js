const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');

test('model toggles keep provider scope and remove disabled models from picker, direct selection and Router',async()=>{
  const preferences=new Map([['activeProviderId','nvidia-a'],['provider','nvidia'],['model','a']]);
  const config={
    inspect:key=>({globalValue:preferences.get(key)}),
    get:(key,fallback)=>preferences.has(key)?preferences.get(key):fallback,
    update:async(key,value)=>{preferences.set(key,value);}
  };
  const vscode={
    workspace:{getConfiguration:()=>config},
    ConfigurationTarget:{Global:1},
    window:{showQuickPick:async(items,options)=>{
      assert.equal(options.canPickMany,true);
      assert.deepEqual(items.map(x=>x.label),['a','b']);
      return [items[1]];
    }}
  };
  const load=Module._load;
  let Gateway;
  try{Module._load=function(id,...args){return id==='vscode'?vscode:load.call(this,id,...args);};({Gateway}=require('../out/extension'));}finally{Module._load=load;}
  const gateway=Object.create(Gateway.prototype);
  const stored=new Map();
  gateway.context={globalState:{get:(key,fallback)=>stored.get(key)??fallback,update:async(key,value)=>{stored.set(key,value);}}};
  const primary={id:'nvidia-a',name:'Test NVIDIA',provider:'nvidia',baseUrl:'https://example.test/v1',models:['a','b']};
  const other={id:'other',name:'Second API',provider:'openai-compatible',baseUrl:'https://other.test/v1',models:['a']};
  gateway.allProfiles=()=>[primary,other];
  gateway.profiles=()=>[primary,other];
  gateway.localModels={profileList:()=>[]};
  gateway.catalog={current:{models:[],providers:[]},snapshotOrLoad:async()=>({models:[]})};
  gateway.notifyModels=()=>{};
  await gateway.manageModels('nvidia-a');
  assert.equal(preferences.get('model'),'b');
  assert.deepEqual(gateway.chatModelState().providers.map(x=>x.models),[['b'],['a']]);
  await assert.rejects(gateway.selectModel('nvidia-a','a'),/disabled/i);
  assert.deepEqual((await gateway.routeCandidates()).map(x=>[x.providerId,x.model]),[['nvidia-a','b'],['other','a']]);
  const freeModel={providerId:'catalog-nvidia',provider:'Test NVIDIA',modelId:'free-b',name:'Free B',free:true,pricingKnown:true,promptCost:0,completionCost:0};
  gateway.catalog.current.models=[freeModel];
  assert.equal(gateway.chatModelState().freeModels[0].connectionId,undefined);
  freeModel.baseUrl='https://example.test/v1/';
  assert.equal(gateway.chatModelState().freeModels[0].connectionId,'nvidia-a');
});
