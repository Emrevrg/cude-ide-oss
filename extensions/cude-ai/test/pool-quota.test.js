const assert=require('node:assert/strict');
const test=require('node:test');
const {parsePoolQuota}=require('../out/poolQuota');
test('Cude Pool usage exposes only validated counters and a confirmed Nythos model',()=>{
  const raw={day:'2026-11-19',device:{used:12,limit:80,token:'private'},nythos:{used:2,limit:25},secret:'private'};
  assert.deepEqual(parsePoolQuota(raw,true),{state:'ready',device:{used:12,limit:80},nythos:{used:2,limit:25},nythosAvailable:true});
  assert.equal(parsePoolQuota(raw,false).nythos,undefined);
  assert.equal(parsePoolQuota(raw,null).nythosAvailable,null);
  assert.equal(parsePoolQuota({device:{used:'12',limit:80}},false),undefined);
  assert.equal(parsePoolQuota({device:{used:-1,limit:80}},false),undefined);
  assert.equal(parsePoolQuota({device:{used:1,limit:0}},false),undefined);
  assert.equal(parsePoolQuota({device:{used:1,limit:80}},true),undefined);
  assert.equal(parsePoolQuota({device:{used:101,limit:80}},false).device.used,101);
});

test('real HTTP quota read authenticates, projects data, and rejects redirects', async t=>{
  const {createServer}=require('node:http');
  const {fetchPoolQuota}=require('../out/poolQuota');
  let mode='ready', visits=0, redirected=0;
  const fakeToken='cude_'+'0'.repeat(64);
  const server=createServer((req,res)=>{
    if(req.url==='/capture'){redirected++;res.writeHead(200);res.end();return;}
    visits++;
    assert.equal(req.method,'GET');
    assert.equal(req.url,'/v1/quota');
    assert.equal(req.headers.authorization,'Bearer '+fakeToken);
    if(mode==='denied'){res.writeHead(403);res.end('Suspended');return;}
    if(mode==='redirect'){res.writeHead(302,{Location:'/capture'});res.end();return;}
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({device:{used:7,limit:80},nythos:{used:1,limit:25},token:fakeToken}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port;
  const read=()=>fetchPoolQuota(fetch,url,{Authorization:'Bearer '+fakeToken},new AbortController().signal,true);
  assert.deepEqual(await read(),{state:'ready',device:{used:7,limit:80},nythos:{used:1,limit:25},nythosAvailable:true});
  mode='denied';
  assert.deepEqual(await read(),{state:'accessDenied'});
  mode='redirect';
  await assert.rejects(read());
  assert.equal(visits,3);
  assert.equal(redirected,0);
});
