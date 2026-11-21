const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {ProjectSemanticIndex,isIndexablePath,semanticChunks}=require('../out/semanticIndex');
const {NOROVOX_ARTIFACTS,prepareSemanticModel,SemanticModelRuntime,semanticServerArgs}=require('../out/semanticModel');
const manifest=require('../package.json');

async function fixture(t){
  const base=path.resolve(process.env.CUDE_TEST_TMP||os.tmpdir());
  const directory=await fs.mkdtemp(path.join(base,'cude-semantic-test-'));
  t.after(async()=>{
    assert.equal(path.dirname(directory),base);
    await fs.rm(directory,{recursive:true,force:true});
  });
  return directory;
}

test('semantic code chunks count the passage prefix, preserve code points and do not skip text',async()=>{
  const content='a🚀ö中'.repeat(220);
  const encoder={tokenize:async value=>Array.from(value,char=>char.codePointAt(0))};
  const chunks=await semanticChunks(content,encoder);
  assert.ok(chunks.length>1);
  assert.equal(chunks.map(chunk=>content.slice(chunk.start,chunk.end)).join(''),content);
  for(const chunk of chunks){
    assert.ok(chunk.tokens.length<=256);
    assert.equal(String.fromCodePoint(...chunk.tokens),'passage: '+content.slice(chunk.start,chunk.end));
  }
});

test('semantic index ranks relevant chunks, updates only changed content and drops removed files',async t=>{
  const workspace=await fixture(t);
  const file=(name)=>path.join(workspace,name);
  let embeddings=0;
  const encoder={
    async tokenize(text){
      return Array.from(text).map(char=>char.codePointAt(0));
    },
    async embed(ids){
      embeddings++;
      const text=String.fromCodePoint(...ids);
      const vector=new Float32Array(768);
      vector[/token|session|valid/.test(text)?5:10]=1;
      return vector;
    }
  };
  await fs.writeFile(file('access.ts'),'export const sessionToken = validate();');
  await fs.writeFile(file('palette.ts'),'const color = "blue";');
  await fs.mkdir(file('hidden'));
  await fs.writeFile(file('hidden/.env'),'PWD=secret should never be indexed');
  await fs.symlink(file('hidden'),file('alias'),'junction');
  for(const name of ['.cude/index/norovox.json','../src.js','node_modules/c.js','hidden/.env','src/token.key','src/package-lock.json']){
    assert.equal(isIndexablePath(name),false,name);
  }
  const index=new ProjectSemanticIndex(workspace,'fixture',encoder);
  assert.equal(await index.exists(),false);
  let stats=await index.refresh(['access.ts','palette.ts','hidden/.env','alias/not-present.ts']);
  assert.deepEqual(stats,{files:2,chunks:2,updated:2,skipped:1});
  assert.equal(embeddings,2);
  const indexPath=file('.cude/index/norovox.json');
  const saved=await fs.readFile(indexPath,'utf8');
  assert.doesNotMatch(saved,/sessionToken|should never be indexed/);
  assert.equal((await index.search('validate a session token'))[0].file,'access.ts');

  stats=await index.refresh(['access.ts','palette.ts']);
  assert.equal(stats.updated,0);
  assert.equal(embeddings,3);
  await fs.writeFile(file('palette.ts'),'const token = "green";');
  await fs.unlink(file('access.ts'));
  stats=await index.refresh(['palette.ts']);
  assert.deepEqual(stats,{files:1,chunks:1,updated:1,skipped:0});
  assert.equal(embeddings,4);
  assert.equal((await index.search('token'))[0].file,'palette.ts');
});

test('semantic downloads require consent, enforce SHA-256 and reject non-Hugging Face redirects',async t=>{
  const directory=await fixture(t);
  const bytes=Buffer.from('test fixture GGUF');
  const artifact={file:'Norovox-Embed-Zero-Q8_0.gguf',size:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex'),meanCosine:0.9999,revision:'a'.repeat(40)};
  const offered=[];
  let downloadCount=0;
  const fetcher=async(url,options)=>{
    downloadCount++;
    assert.equal(options.redirect,'manual');
    if(url.hostname==='huggingface.co'){
      assert.ok(url.pathname.includes(artifact.revision));
      return new Response(null,{status:302,headers:{location:'https://cas-bridge.xethub.hf.co/fixture'}});
    }
    return new Response(bytes);
  };
  let result=await prepareSemanticModel(artifact,directory,async()=>false,()=>{},undefined,fetcher);
  assert.equal(result,undefined);
  assert.equal(downloadCount,0);
  const fake=async()=>new Response(Buffer.from('a'.repeat(bytes.length)));
  await assert.rejects(prepareSemanticModel(artifact,directory,async()=>true,()=>{},undefined,fake),/SHA-256/);
  assert.deepEqual(await fs.readdir(directory),[]);
  await assert.rejects(prepareSemanticModel(artifact,directory,async()=>true,()=>{},undefined,async()=>new Response(null,{
    status:302,headers:{location:'https://outside.example/file.gguf'}
  })),/left the Hugging Face CDN/);
  result=await prepareSemanticModel(artifact,directory,async()=>true,size=>offered.push(size),undefined,fetcher);
  assert.deepEqual(await fs.readFile(result),bytes);
  assert.equal(downloadCount,2);
  assert.equal(offered.at(-1),bytes.length);
  assert.equal(await prepareSemanticModel(artifact,directory,async()=>assert.fail('verified artifact should be reused'),()=>{},undefined,fetcher),result);
  assert.deepEqual(await fs.readdir(directory),[artifact.file]);
  await assert.rejects(prepareSemanticModel({...artifact,meanCosine:0.998},directory,async()=>true,()=>{},undefined,fetcher),/release verification/);
});

test('manifest exposes semantic indexing and runtime binds authenticated embedding-only loopback',()=>{
  assert.deepEqual(NOROVOX_ARTIFACTS.map(item=>item.file),['Norovox-Embed-Zero-Q8_0.gguf','Norovox-Embed-Zero-F16.gguf']);
  for(const artifact of NOROVOX_ARTIFACTS){
    assert.ok(artifact.meanCosine>=0.999);
    assert.match(artifact.sha256,/^[a-f0-9]{64}$/);
    assert.match(artifact.revision,/^[a-f0-9]{40}$/);
  }
  assert.ok(manifest.contributes.commands.some(command=>command.command==='cude-ai.indexProjectSemantic'&&command.title==='Cude: Index Project (Semantic)'));
  const args=semanticServerArgs('fixture.gguf',9521,'local-runtime-test');
  assert.deepEqual(args.slice(args.indexOf('--host'),args.indexOf('--host')+2),['--host','127.0.0.1']);
  assert.deepEqual(args.slice(args.indexOf('--api-key'),args.indexOf('--api-key')+2),['--api-key','local-runtime-test']);
  assert.ok(args.includes('--embedding'));
  assert.equal(args[args.indexOf('--pooling')+1],'mean');
});

test('bundled llama-server indexes and retrieves project source using a verified GGUF', {skip:!process.env.CUDE_SEMANTIC_TEST_MODEL}, async t=>{
  const workspace=await fixture(t);
  const runtime=new SemanticModelRuntime(path.resolve(__dirname,'../bin/llama/llama-server.exe'));
  t.after(()=>runtime.dispose());
  await runtime.start(process.env.CUDE_SEMANTIC_TEST_MODEL);
  assert.deepEqual(await runtime.tokenize('query: Cafe\u0301'),await runtime.tokenize('query: Café'));
  await fs.writeFile(path.join(workspace,'access.ts'),'// Invalidate expired sessions and revoke access tokens\nexport const revokeExpired = (session) => session.expiresAt < Date.now();');
  await fs.writeFile(path.join(workspace,'palette.css'),'body { background: blue; color: white; }');
  const index=new ProjectSemanticIndex(workspace,'real-gguf-test',runtime);
  assert.equal((await index.refresh(['access.ts','palette.css'])).updated,2);
  assert.equal((await index.search('Where do expired sessions get revoked?'))[0].file,'access.ts');
  assert.equal((await index.refresh(['access.ts','palette.css'])).updated,0);
});
