const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const {PROVIDER_PRESETS}=require('../out/providerPresets');
const {callProvider}=require('../out/providerWire');

test('all curated auth-required presets reject missing and invalid credentials',async()=>{
  const before=Module._load;
  let Gateway;
  try{
    Module._load=function(id,...args){
      return id==='vscode'?{ workspace:{getConfiguration:()=>({get:(_k,fallback)=>fallback})} }:before.call(this,id,...args);
    };
    ({Gateway}=require('../out/extension'));
  }finally{Module._load=before;}
  const gateway=Object.assign(Object.create(Gateway.prototype),{profiles:()=>[],secrets:{}});
  for(const preset of PROVIDER_PRESETS.filter(preset=>preset.category!=='Local'&&preset.auth!=='none')){
    const url=preset.id==='azure-openai'?'https://fixture.openai.azure.com/openai/v1':preset.baseUrl;
    const form={provider:preset.provider,url};
    await assert.rejects(gateway.formCredentials(form),/API key is required/i,preset.name);
    for(const status of [401,403]){
      const invalid='provider-fixture';
      const key=(await gateway.formCredentials({...form,key:invalid})).key;
      await assert.rejects(callProvider({
        provider:preset.provider,base:url,model:'fixture',messages:[{role:'user',content:'OK?'}],key,stream:false,text:message=>message,
        fetch:async(_url,request)=>{
          const expected={bearer:'authorization',azure:'api-key',anthropic:'x-api-key',gemini:'x-goog-api-key'}[preset.auth];
          assert.equal(request.headers[expected],expected==='authorization'?'Bearer '+invalid:invalid);
          return new Response(JSON.stringify({error:invalid}),{status});
        },
      }),error=>error.status===status&&error.message==='authentication'&&!error.body,preset.name);
    }
  }
});

test('a stream cut off before termination is surfaced after one partial delta',async()=>{
  let calls=0;const parts=[];
  await assert.rejects(callProvider({
    provider:'openai',base:'https://example.test/v1',model:'fixture',
    messages:[],stream:true,text:key=>key,onDelta:delta=>parts.push(delta),
    fetch:async()=>{calls++;return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',{headers:{'content-type':'text/event-stream'}});},
  }),/streamInterrupted/);
  assert.deepEqual(parts,['partial']);
  assert.equal(calls,1);
});
