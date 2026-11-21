const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { chooseRoute, classifyTask, isFallbackError, withFallback } = require('../out/router.js');
const { isFreeCatalogModel } = require('../out/freeModels.js');
const { inspectHuggingFaceModel, listDownloadedModels, listDownloadedModelsFromRoots, recommendedLocalModels, searchHuggingFace } = require('../out/localModels.js');
const http = require('node:http');
const net = require('node:net');
const { I18N } = require('../out/i18n.js');
const { fetch: undiciFetch, ProxyAgent } = require('undici');

test('0h bundled catalog has real offline model/provider inventory and metadata', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data', 'model-catalog.json'), 'utf8'));
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(catalog.models.length > 1100, `catalog contains ${catalog.models.length} models`);
  assert.ok(catalog.providers.length > 100, `catalog contains ${catalog.providers.length} providers`);
  assert.ok(catalog.models.some(model => model.contextLength > 0));
  assert.ok(catalog.models.some(model => model.source === 'openrouter'));
  assert.ok(catalog.models.some(model => model.source === 'models.dev'));
  assert.ok(catalog.sources['models.dev'].url.includes('models.dev'));
  assert.ok(catalog.sources.openrouter.url.includes('/api/v1/models'));
});

test('0h Router selects task capabilities and user cost/speed preferences', () => {
  const cheap = { providerId: 'local', provider: 'Local', model: 'small', metadata: { promptCost: 0, completionCost: 0, contextLength: 32000, toolCall: false, vision: false, reasoning: false, openWeights: true } };
  const capable = { providerId: 'cloud', provider: 'Cloud', model: 'reasoning', metadata: { promptCost: 2, completionCost: 4, contextLength: 1000000, toolCall: true, vision: true, reasoning: true } };
  assert.equal(classifyTask('Please review this code review and git diff'), 'review');
  assert.equal(classifyTask('Analyze image_url and explain image understanding'), 'vision');
  assert.equal(classifyTask('Complete only the code <|fim_prefix|>'), 'completion');
  assert.equal(chooseRoute([cheap, capable], 'quality', 'review').model, 'reasoning');
  assert.equal(chooseRoute([cheap, capable], 'cost', 'chat').model, 'small');
  assert.equal(chooseRoute([cheap, capable], 'quality', 'vision').model, 'reasoning');
  assert.equal(isFallbackError(new Error('Provider quota/rate limit (429).')), true);
  assert.equal(isFallbackError(new Error('invalid API key (401).')), false);
  const fast = { ...cheap, latencyMs: 90 }, slow = { ...capable, latencyMs: 900 };
  assert.equal(chooseRoute([fast, slow], 'speed', 'chat').model, 'small');
});

test('0m Free-only classification fails closed for unknown pricing and paid fallback', async () => {
  const unknown={id:'vendor/unknown',pricingKnown:false,promptCost:0,completionCost:0};
  const pricedZero={id:'vendor/free',pricingKnown:true,promptCost:0,completionCost:0};
  const openRouterFree={id:'openrouter/qwen:free',pricingKnown:false,promptCost:0,completionCost:0};
  assert.equal(isFreeCatalogModel(unknown),false);
  assert.equal(isFreeCatalogModel(pricedZero),true);
  assert.equal(isFreeCatalogModel(openRouterFree),true);
  const candidates=[{model:'paid',free:false},{model:'unknown',free:undefined},{model:'free-a',free:true},{model:'free-b',free:true}].filter(candidate=>candidate.free===true);
  const attempted=[];const result=await withFallback(candidates,async candidate=>{attempted.push(candidate.model);if(candidate.model==='free-a')throw new Error('429 rate limit');return candidate.model;},isFallbackError);
  assert.deepEqual(attempted,['free-a','free-b']);assert.equal(result.value,'free-b');
});

test('0m local model discovery includes downloaded GGUF files in nested folders', async () => {
  const os=require('node:os');const temp=fs.mkdtempSync(path.join('E:/CudeBuildCache','cude-model-scan-'));
  try{const nested=path.join(temp,'codex','models');fs.mkdirSync(nested,{recursive:true});fs.writeFileSync(path.join(temp,'top.gguf'),'model');fs.writeFileSync(path.join(nested,'qwen.gguf'),'weights');fs.writeFileSync(path.join(nested,'partial.gguf.part'),'partial');const found=await listDownloadedModels(temp);assert.deepEqual(found.map(file=>file.name).sort(),['qwen.gguf','top.gguf']);}
  finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('0m HF search returns summary cards before loading file metadata', async () => {
  const original=global.fetch;let calls=0;
  try{global.fetch=async(url,init)=>{calls++;assert.equal(new URL(url).searchParams.has('blobs'),false);return new Response(JSON.stringify([{id:'Qwen/Qwen2.5-0.5B-Instruct-GGUF',downloads:12,likes:2,tags:['gguf','license:apache-2.0']}]),{status:200,headers:{'content-type':'application/json'}});};const rows=await searchHuggingFace('qwen 0.5b',{usableBytes:12*1024**3,gpu:'940MX'});assert.equal(calls,1);assert.equal(rows[0].detailsPending,true);assert.equal(rows[0].files.length,0);assert.equal(rows[0].license,'apache-2.0');}
  finally{global.fetch=original;}
});

test('0m HF model detail fetch happens on demand and fixed PC recommendations need no network', async () => {
  const original=global.fetch;let calls=0;const device={usableBytes:11*1024**3,gpu:'GeForce 940MX'};
  try{global.fetch=async(url)=>{calls++;assert.match(String(url),/blobs=true/);return new Response(JSON.stringify({id:'Qwen/Qwen2.5-0.5B-Instruct-GGUF',cardData:{license:'apache-2.0'},siblings:[{rfilename:'q4.gguf',lfs:{size:300,sha256:'abc'}},{rfilename:'readme.md'}]}),{status:200,headers:{'content-type':'application/json'}});};const model=await inspectHuggingFaceModel('Qwen/Qwen2.5-0.5B-Instruct-GGUF',device);assert.equal(calls,1);assert.equal(model.files.length,1);assert.equal(model.files[0].size,300);}
  finally{global.fetch=original;}
  const recs=recommendedLocalModels(device);assert.equal(calls,1);assert.equal(recs.length,8);assert.ok(recs.some(model=>model.id==='Qwen/Qwen2.5-0.5B-Instruct-GGUF'));assert.ok(recs.some(model=>model.id==='emrevrg/Norovox-N1-0.5B-GGUF'));assert.ok(recs.every(model=>model.detailsPending||(model.files[0].fits&&model.files[0].recommended)));
});

test('0m model scanner combines configured and external E-drive roots', async () => {
  const temp=fs.mkdtempSync(path.join('E:/CudeBuildCache','cude-model-roots-'));
  try{const app=path.join(temp,'app-models'),external=path.join(temp,'external','nested');fs.mkdirSync(app,{recursive:true});fs.mkdirSync(external,{recursive:true});fs.writeFileSync(path.join(app,'small.gguf'),'local');fs.writeFileSync(path.join(external,'qwen.gguf'),'qwen');const rows=await listDownloadedModelsFromRoots([app,path.join(temp,'external')]);assert.deepEqual(rows.map(row=>row.name),['qwen.gguf','small.gguf']);}
  finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('0m free pool, strict routing setting, translations, and bounded HF status are wired', () => {
  const source=fs.readFileSync(path.join(root,'src','extension.ts'),'utf8'),local=fs.readFileSync(path.join(root,'src','localModels.ts'),'utf8'),ui=fs.readFileSync(path.join(root,'media','providers.html'),'utf8'),manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  assert.match(source,/candidate=>!freeOnly\|\|candidate\.free===true/);assert.match(source,/router\.maxDailyRequests/);assert.match(source,/openFreeKey/);assert.match(source,/\.env/);
  assert.match(local,/AbortSignal\.timeout\(15000\)/);assert.match(local,/AbortSignal\.timeout\(15000\)/);assert.match(ui,/id="freeProviders"/);assert.match(ui,/id="recommendedModels"/);assert.match(ui,/localSearchError/);assert.match(ui,/searching/);
  assert.ok(manifest.contributes.configuration.properties['cude-ai.router.maxDailyRequests']);assert.deepEqual(Object.keys(I18N.en).sort(),Object.keys(I18N.tr).sort());
});

test('0h Router retries a real local HTTP 429 on the next model candidate', async () => {
  let firstHits=0,secondHits=0;
  const start=(handler)=>new Promise(resolve=>{const server=http.createServer(handler);server.listen(0,'127.0.0.1',()=>resolve(server));});
  const first=await start((_req,res)=>{firstHits++;res.writeHead(429,{'content-type':'application/json'});res.end('{"error":"rate limit"}');});
  const second=await start((_req,res)=>{secondHits++;res.writeHead(200,{'content-type':'application/json'});res.end('{"choices":[{"message":{"content":"ok"}}]}');});
  const address=server=>`http://127.0.0.1:${server.address().port}`;
  try{
    const candidates=[{providerId:'fake-primary',provider:'Primary',model:'mock-a'},{providerId:'fake-secondary',provider:'Secondary',model:'mock-b'}];
    const result=await withFallback(candidates,async(candidate)=>{const url=candidate.providerId==='fake-primary'?address(first):address(second);const response=await fetch(url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:candidate.model,messages:[{role:'user',content:'hello'}]})});if(!response.ok)throw new Error(`provider HTTP ${response.status} rate limit`);return response.json();},isFallbackError);
    assert.equal(result.candidate.model,'mock-b');assert.equal(result.value.choices[0].message.content,'ok');assert.equal(firstHits,1);assert.equal(secondHits,1);
  }finally{await Promise.all([first,second].map(server=>new Promise(resolve=>server.close(resolve))));}
});

test('0h enterprise proxy field routes provider requests through a proxy agent', async () => {
  const target=http.createServer((_req,res)=>res.end('proxy-target-ok'));
  await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
  const proxy=http.createServer((req,res)=>{const url=new URL(req.url);const outgoing=http.request({host:url.hostname,port:url.port,path:url.pathname,method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode||502,response.headers);response.pipe(res);});req.pipe(outgoing);});
  const tunnels=new Set();proxy.on('connect',(req,client,head)=>{const [host,port]=req.url.split(':');const upstream=net.connect(Number(port),host,()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.pipe(client);client.pipe(upstream);});tunnels.add(upstream);tunnels.add(client);upstream.on('close',()=>tunnels.delete(upstream));client.on('close',()=>tunnels.delete(client));});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const agent=new ProxyAgent(`http://127.0.0.1:${proxy.address().port}`);
  try{
    const response=await Promise.race([undiciFetch(`http://127.0.0.1:${target.address().port}/health`,{dispatcher:agent}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('proxy request timeout')),3000))]);
    assert.equal(await response.text(),'proxy-target-ok');
  }finally{await agent.close();for(const socket of tunnels)socket.destroy();proxy.closeAllConnections();target.closeAllConnections();await Promise.all([proxy,target].map(server=>new Promise(resolve=>server.close(resolve))));}
});

test('provider settings use one searchable list and a separate bundled local-model surface', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
  const providerUi = fs.readFileSync(path.join(root, 'media', 'providers.html'), 'utf8');
  const chat = fs.readFileSync(path.join(root, 'media', 'chat.html'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(source, /type:'route',\.\.\.route/);
  assert.match(source, /type==='refreshCatalog'/);
  assert.match(source, /performance\.now\(\)/);
  assert.doesNotMatch(providerUi, /data-category=/);
  assert.match(providerUi, /id="local-models"|class="local-models"/);
  assert.match(source, /searchHuggingFace/);
  assert.match(source, /downloadHuggingFaceModel/);
  assert.match(source, /llama-server\.exe/);
  assert.match(providerUi, /customHeaders/);
  assert.match(providerUi, /catalogCount/);
  let rendered=providerUi.replaceAll('{{NONCE}}','test-nonce').replace('{{PRESETS}}','[]').replace('{{PROFILES}}','[]').replace('{{LOCAL_AGENTS}}','[]').replace('{{LOCAL_MODELS}}','[]').replace('{{FREE_PROVIDERS}}','[]').replace('{{RECOMMENDED_MODELS}}','[]').replace('{{DEVICE}}','{"ram":0,"vram":0,"cores":0,"gpu":"CPU","usable":0,"directory":"E:/models"}').replace('{{CATALOG}}','{"models":10548,"providers":327,"freeModels":0,"freeOnly":false,"requestUsage":0,"requestLimit":200}').replace('{{ACTIVE}}','""').replace('{{LANG}}','en').replace('{{CLI_ENABLED}}','false').replace('{{ICONS}}','{}').replace('{{FOCUS}}','""').replace('{{POOL_URL}}','""').replace('{{I18N}}',JSON.stringify(I18N));
  const script=rendered.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/)?.[1];assert.ok(script);assert.doesNotThrow(()=>new (require('node:vm').Script)(script));
  assert.ok(pkg.contributes.commands.some(command=>command.command==='cude-ai.routerSettings'));
  assert.match(chat, /data\.type==='route'/);
  assert.match(chat, /router\.route/);
  assert.match(chat, /model\.addProvider/);
  assert.match(chat, /modelSearchQuery/);
  assert.ok(pkg.activationEvents.includes('onCommand:cude-ai.routerSettings'));
  assert.deepEqual(Object.keys(I18N.en).sort(),Object.keys(I18N.tr).sort());
});

test('local agent detection is silent on startup and recognizes Windows command shims', () => {
  const source=fs.readFileSync(path.join(root,'src','extension.ts'),'utf8');
  const chat=fs.readFileSync(path.join(root,'media','chat.html'),'utf8');
  assert.match(source,/split\(path\.delimiter\)/);assert.doesNotMatch(source,/execFileSync\(win\?'where\.exe'/);assert.match(source,/localCliCache/);
  assert.match(source,/process\.env\.APPDATA/);
  assert.match(source,/Programs','OpenCode|Programs','OpenCode/);
  assert.match(source,/home,'\.local','bin'/);
  assert.match(source,/resolveLocalCliInvocation/);
  assert.doesNotMatch(source,/No supported local assistant tools were detected/);
  assert.match(source,/message\.action==='clone'/);
  assert.match(chat,/function openModelFromTop\(\)/);
  assert.match(chat,/\.composer #model-menu \{ display: none; \}/);
  assert.match(chat,/type: 'attach', action: 'file'/);
  assert.match(chat,/id="project-button"/);
  assert.match(chat,/id="cuets-empty"/);
});
