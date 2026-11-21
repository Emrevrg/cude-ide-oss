'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module');
test('the real Gateway chat and staged agent write paths stop before provider or filesystem access on mandatory update',async()=>{
 const load=Module._load;
 let extension,update;
 try{Module._load=function(id,...args){return id==='vscode'?{workspace:{getConfiguration(){throw Error('provider configuration must not be read');}}}:load.call(this,id,...args);};extension=require('../out/extension');update=require('../out/forcedUpdate');}finally{Module._load=load;}
 update.activityGate.block('mandatory update integration guard');
 try{
  const gateway=Object.create(extension.Gateway.prototype);
  await assert.rejects(gateway.chat([{role:'user',content:'hello'}]),/mandatory update integration guard/);
  const view=Object.create(extension.CudeChatView.prototype);
  await assert.rejects(view.applyStaged([]),/mandatory update integration guard/);
 }finally{update.activityGate.allow();}
});

test('an in-flight agent response cannot write after a mandatory update blocks activity',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cude-agent-update-'));
 const {activityGate}=require('../out/updatePolicy'),{runAgentLoop}=require('../out/agentLoop');
 try{
  await assert.rejects(runAgentLoop({task:'Write a file',workspace:dir,permission:'auto',
   chat:async()=>{activityGate.block('mandatory update during agent response');return JSON.stringify({tool:'write_file',args:{path:'blocked.txt',content:'never'}});},
   confirm:async()=>true,events:{activity:()=>{}},text:key=>key,maxSteps:5,maxMinutes:1}),/mandatory update during agent response/);
  assert.equal(fs.existsSync(path.join(dir,'blocked.txt')),false);
 }finally{activityGate.allow();fs.rmSync(dir,{recursive:true,force:true});}
});
test('pool transport enrolls once and signs each distinct request, including account and card routes',async()=>{
 const device=require('../out/deviceId'),old=device.getDevice;
 const identity={cui:device.newCui(),fingerprint:'a'.repeat(64),secret:'b'.repeat(64)};
 const store=require('../../../gateway/store').openStore(':memory:');
 const devices=require('../../../gateway/devices').openDevices(store.db),client=store.issue(),seen=new Set();let enrollments=0;
 const context={extension:{packageJSON:{version:'0.1.0'}}};
 device.getDevice=async()=>identity;
 try{
  const {deviceFetch}=require('../out/deviceTransport');
  const request=async(url,init)=>{
   const path=new URL(url).pathname;
   if(path==='/v1/devices/register'){enrollments++;return Response.json(devices.register(client.id,JSON.parse(init.body)));}
   const headers=Object.fromEntries(new Headers(init.headers).entries());
   assert.equal(devices.authorize(client.id,{method:init.method||'GET',url:path,headers,socket:{remoteAddress:'127.0.0.1'}}),'ok');
   assert.ok(!seen.has(headers['x-cude-nonce']));seen.add(headers['x-cude-nonce']);return Response.json({ok:true});
  };
  for(const [method,route]of [['GET','quota'],['GET','account'],['POST','card/redeem'],['POST','chat/completions']]){
   const response=await deviceFetch(context,request,'https://pool.example.test/v1/'+route,{method,headers:{authorization:'Bearer '+client.token},body:method==='POST'?'{}':undefined});
   assert.equal(response.status,200);
  }
  assert.equal(enrollments,1);assert.equal(seen.size,4);
 }finally{device.getDevice=old;devices.close();store.close();}
});
