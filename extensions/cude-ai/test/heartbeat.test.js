const test=require('node:test'),assert=require('node:assert/strict');
const {createHmac,createHash}=require('node:crypto');
const {heartbeatBody,signPresence,firewallMessage}=require('../out/heartbeatWire');
test('heartbeat projects exactly three status fields and never includes caller work',()=>{
 const b=heartbeatBody('0.1.0','ok','current',{fileName:'private',chat:'private'});
 assert.deepEqual(b,{appVersion:'0.1.0',integrity:'ok',updateState:'current'});
});
test('presence MAC binds route, body and manifest digest; firewall messages support TR/EN',()=>{
 const secret='a'.repeat(64),headers=new Headers({'x-cude-timestamp':'123','x-cude-nonce':'nonce','x-cude-manifest-hash':'b'.repeat(64)}),body=JSON.stringify(heartbeatBody('0.1.0','ok','current'));
 const payload=['POST','/v1/devices/heartbeat','123','nonce',createHash('sha256').update(body).digest('hex'),'b'.repeat(64)].join('\n');
 assert.equal(signPresence({secret},'POST','/v1/devices/heartbeat',headers,body),createHmac('sha256',Buffer.from(secret,'hex')).update(payload).digest('hex'));
 assert.notEqual(signPresence({secret},'POST','/v1/devices/heartbeat',headers,body+' '),signPresence({secret},'POST','/v1/devices/heartbeat',headers,body));
 assert.equal(firewallMessage('region_blocked','tr'),'Bu konumdan/ağdan erişim kapalı.');assert.match(firewallMessage('network_blocked','en'),/Access/);assert.equal(firewallMessage('other','en'),undefined);
});
test('heartbeat waits for pool credentials, runs every two minutes, and sends signed transport offline at shutdown',async()=>{
 const Module=require('node:module'),load=Module._load,interval=global.setInterval,clear=global.clearInterval;
 let tick,period,connection,calls=[],cleared=false;
 const context={extension:{packageJSON:{version:'0.1.0'}},subscriptions:[],extensionPath:'unused'};
 const transport={deviceFetch:async(_context,_request,url,init)=>{calls.push({url,init});return {ok:true,body:{cancel:async()=>{}}};}};
 try{
  Module._load=function(name,parent,...rest){if(parent?.filename.endsWith('heartbeat.js')){if(name==='./deviceTransport')return transport;if(name==='./releaseTrust')return {readReleaseTrust:async()=>undefined};if(name==='./forcedUpdate')return {heartbeatUpdateState:()=> 'available'};}return load.call(this,name,parent,...rest);};
  delete require.cache[require.resolve('../out/heartbeat')];const {startHeartbeat,stopHeartbeat}=require('../out/heartbeat');Module._load=load;
  global.setInterval=(fn,ms)=>{tick=fn;period=ms;return {unref(){}};};global.clearInterval=()=>{cleared=true;};
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  startHeartbeat(context,async()=>{throw Error('must use device transport');},async()=>connection);await flush();assert.equal(period,120000);assert.equal(calls.length,0);
  connection={url:'https://pool.example',headers:{Authorization:'Bearer cude_test'}};tick();await flush();assert.equal(calls.length,1);assert.deepEqual(JSON.parse(calls[0].init.body),{appVersion:'0.1.0',integrity:'unsigned',updateState:'available'});assert.equal(calls[0].init.headers['X-Cude-Manifest-Hash'],'');
  connection=undefined;tick();await flush();assert.equal(calls.length,1);
  connection={url:'https://pool.example',headers:{Authorization:'Bearer cude_test'}};tick();await flush();await stopHeartbeat();assert.equal(calls.length,3);assert.equal(calls[2].url,'https://pool.example/v1/devices/offline');assert.equal(calls[2].init.body,'{}');assert.equal(cleared,true);tick();await flush();assert.equal(calls.length,3);
 }finally{Module._load=load;global.setInterval=interval;global.clearInterval=clear;delete require.cache[require.resolve('../out/heartbeat')];}
});
