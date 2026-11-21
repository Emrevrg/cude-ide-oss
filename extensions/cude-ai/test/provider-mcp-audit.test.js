const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const Module=require('node:module');
const {credentialSlot,readProviderCredentials,writeProviderCredentials,mergeImportedProfiles}=require('../out/providerCredentials');
const {configuredMcpHeaders,mcpEnvironment,processEnvironment,boundedMcpBody}=require('../out/mcpSecurity');
const {localCliAuth,permitsLocalCli}=require('../out/localCliSecurity');
const originalLoad=Module._load;
Module._load=function(request,parent,isMain){return request==='vscode'?{}:originalLoad.call(this,request,parent,isMain)};
const {withHttpMcp}=require('../out/extension');
Module._load=originalLoad;
test('provider credentials are pinned to the exact normalized endpoint, id and wire provider',async()=>{
  const secrets=new Map();
  const store={get:async key=>secrets.get(key),store:async (key,value)=>void secrets.set(key,value),delete:async key=>void secrets.delete(key)};
  const chosen={id:'provider-1',provider:'nvidia',baseUrl:'https://real.example/v1'};
  const value={key:'test-only-key',headers:{'x-auth':'test-only-header'},proxy:'http://test-only:proxy@127.0.0.1:9000'};
  const legacy='cude-ai.apiKey.provider-1';
  secrets.set(legacy,'unbound-test-key');
  assert.equal((await readProviderCredentials(store,chosen)).key,'');
  await writeProviderCredentials(store,chosen,value);
  assert.deepEqual(await readProviderCredentials(store,{...chosen,baseUrl:'https://REAL.Example:443/v1/'}),value);
  for(const changed of [
    {baseUrl:'https://elsewhere.example/v1'},{baseUrl:'https://real.example/v2'},{provider:'openai'},{id:'provider-2'}
  ]){
    assert.notEqual(credentialSlot({...chosen,...changed}),credentialSlot(chosen));
    assert.deepEqual(await readProviderCredentials(store,{...chosen,...changed}),{key:'',headers:{},proxy:''});
  }
  assert.equal(secrets.get(legacy),'unbound-test-key');
});
test('provider import leaves colliding profiles intact and remints exported IDs',()=>{
  const saved={id:'saved',name:'Existing',provider:'nvidia',baseUrl:'https://real.example/v1'};
  const copied={id:'exported',name:'New',provider:'openai',baseUrl:'https://other.example/v1'};
  const evil={...saved,baseUrl:'https://elsewhere.example/v1'};
  const merged=mergeImportedProfiles([saved],[evil,copied,copied],()=> 'provider-reminted');
  assert.equal(merged.count,1);
  assert.deepEqual(merged.profiles,[saved,{...copied,id:'provider-reminted'}]);
});
test('MCP rejects reserved transport and duplicate headers, and stdio never inherits unrelated secrets',()=>{
  assert.deepEqual({...configuredMcpHeaders({Authorization:'Bearer test-only','X-Custom':'v'})},{authorization:'Bearer test-only','x-custom':'v'});
  for(const bad of [{'HoSt':'other'},{'mcp-session-id':'fake'},{'PROXY-AUTHORIZATION':'bad'},{'X-Custom':'a','x-cUStom':'b'},{'x-custom':'x\r\ny'}])assert.throws(()=>configuredMcpHeaders(bad),/restricted/);
  const source={Path:'test-path',HOME:'test-home',OPENAI_API_KEY:'test-only',NVIDIA_API_KEY:'external-key',NODE_OPTIONS:'--require external'};
  assert.deepEqual(mcpEnvironment({MCP_TOKEN:'explicit'},source),{Path:'test-path',HOME:'test-home',MCP_TOKEN:'explicit'});
  assert.throws(()=>mcpEnvironment({NODE_OPTIONS:'--require external'},source),/restricted/);
  assert.throws(()=>mcpEnvironment({Path:'workspace-bin'},source),/restricted/);
  assert.deepEqual(processEnvironment(localCliAuth['codex-cli'],source),{Path:'test-path',HOME:'test-home',OPENAI_API_KEY:'test-only'});
  for(const cli of ['gemini-cli','qwen-code','opencode-cli']){
    for(const mode of ['ask','plan','readonly'])assert.equal(permitsLocalCli(cli,mode),false);
    assert.equal(permitsLocalCli(cli,'auto'),true);
  }
  assert.equal(permitsLocalCli('codex-cli','readonly'),true);
});
test('bounded MCP body rejects oversized streamed replies',async()=>{
  const response=new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(5));controller.enqueue(new Uint8Array(5));controller.close()}}));
  await assert.rejects(boundedMcpBody(response,8),/size limit/);
});
test('loopback MCP validates protocol, rejects response over limit and never sends redirects',async t=>{
  let mode='wrong-id',hits=0;
  const server=http.createServer(async(req,res)=>{
    hits++;
    if(req.url==='/capture'){res.writeHead(200);res.end();return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const request=JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.headers.authorization,'Bearer fixture-mcp-token');
    if(mode==='redirect'){res.writeHead(302,{Location:'/capture'});res.end();return;}
    res.setHeader('content-type','application/json');
    if(mode==='large'){res.write('x'.repeat(1000001));res.end();return;}
    res.end(JSON.stringify({jsonrpc:'2.0',id:request.id+1,result:{protocolVersion:'2025-03-26'}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const read=()=>withHttpMcp({url:'http://127.0.0.1:'+server.address().port+'/mcp',headers:{Authorization:'Bearer fixture-mcp-token'}},()=>assert.fail('Must not run'));
  await assert.rejects(read(),/Invalid MCP response/);
  mode='large';await assert.rejects(read(),/size limit/);
  mode='redirect';await assert.rejects(read());
  assert.equal(hits,3);
});
