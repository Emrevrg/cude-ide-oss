'use strict';
// Uses exactly the extension's normalization, and atomically updates the bundled copy.
const fs=require('node:fs/promises'),path=require('node:path'),Module=require('node:module');
const load=Module._load;
Module._load=function(id,...args){return id==='vscode'?{}:load.call(this,id,...args);};
const {normalizeCatalog}=require('../out/modelCatalog');Module._load=load;
async function refresh(){
 const urls=['https://models.dev/api.json?type=all','https://openrouter.ai/api/v1/models'];
 const raw=await Promise.all(urls.map(async url=>{
  let last;
  for(let attempt=0;attempt<3;attempt++)try{const r=await fetch(url,{signal:AbortSignal.timeout(45000)});if(!r.ok)throw Error('HTTP '+r.status);return await r.json();}catch(error){last=error;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));}
  throw Error(new URL(url).host+': '+last.message);
 }));
 const catalog=normalizeCatalog(...raw);
 if(catalog.models.length<100||!catalog.sources.openrouter.models||!catalog.sources['models.dev'].models)throw Error('Incomplete catalog; old file preserved');
 const file=path.resolve(__dirname,'../data/model-catalog.json'),temp=file+'.tmp';
 await fs.writeFile(temp,JSON.stringify(catalog));await fs.rename(temp,file);
 console.log(JSON.stringify({updatedAt:catalog.updatedAt,sources:catalog.sources,models:catalog.models.length}));
}
refresh().catch(error=>{console.error(error.message);process.exitCode=1;});
