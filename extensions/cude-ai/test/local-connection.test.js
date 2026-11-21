const test=require('node:test'),assert=require('node:assert/strict');
const {connectLocalServer,localRuntimeSettings,localRuntimeFailure}=require('../out/localConnection');
const {recommendedLocalModels}=require('../out/localModels');
test('local one-click connection discovers, saves and selects in order; failures never save',async()=>{
 const events=[];
 const result=await connectLocalServer(async()=>{events.push('test');return ['local-one','local-two'];},async models=>{events.push('save');return {id:'saved',models};},async(p,m)=>{events.push('select');assert.equal(p.id,'saved');assert.equal(m,'local-one');});
 assert.deepEqual(events,['test','save','select']);assert.equal(result.models.length,2);
 await assert.rejects(connectLocalServer(async()=>[],()=>assert.fail('must not save'),()=>assert.fail('must not select')),/No loaded/);
 await assert.rejects(connectLocalServer(async()=>{throw Error('offline');},()=>assert.fail('must not save'),()=>assert.fail('must not select')),/offline/);
});
test('local runtime sizes context and GPU offload conservatively for RAM and VRAM',()=>{
 const gib=1024**3;
 assert.deepEqual(localRuntimeSettings(4*gib,{ramBytes:8*gib,vramBytes:0}),{context:2048,gpuLayers:0});
 assert.equal(localRuntimeSettings(4*gib,{ramBytes:16*gib,vramBytes:3*gib}).gpuLayers,16);
 assert.equal(localRuntimeSettings(0.5*gib,{ramBytes:12*gib,vramBytes:0}).context,8192,'small models get 8k context for the agent');
 assert.deepEqual(localRuntimeSettings(4*gib,{ramBytes:32*gib,vramBytes:8*gib}),{context:8192,gpuLayers:999});
 const recs=recommendedLocalModels({ramBytes:16*gib,vramBytes:4*gib,usableBytes:18*gib,cpuCores:8,gpu:'test'});
 assert.ok(recs.slice(0,3).every(m=>m.id.includes('Norovox-N1')));assert.ok(recs.some(m=>m.id.includes('Qwen3')));
 assert.ok(recommendedLocalModels({usableBytes:gib,vramBytes:0}).every(m=>m.files.every(f=>f.fits)));
 assert.match(localRuntimeFailure('CUDA out of memory'),/smaller GGUF/);
 assert.match(localRuntimeFailure('missing DLL'),/GPU driver/);
});
