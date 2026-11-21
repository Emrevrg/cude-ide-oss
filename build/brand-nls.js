// Replaces upstream product names in built-in extension display strings (package.nls*.json).
// Display text only; ids and settings keys are untouched.
const fs=require('node:fs'),path=require('node:path');
const root=path.join(process.argv[2],'extensions');
const map=[[/Light \(VSCodium\)/g,'Light Classic'],[/Dark \(VSCodium\)/g,'Dark Classic'],[/Minimal \(VSCodium\)/g,'Minimal'],[/Visual Studio Code/g,'Cude IDE'],[/VSCodium/g,'Cude IDE'],[/VS Code/g,'Cude IDE']];
let changed=0;
for(const dir of fs.readdirSync(root)){
  const folder=path.join(root,dir);if(!fs.statSync(folder).isDirectory())continue;
  for(const file of fs.readdirSync(folder).filter(f=>/^package\.nls(\..+)?\.json$/.test(f))){
    const full=path.join(folder,file),before=fs.readFileSync(full,'utf8');let after=before;
    for(const [re,to] of map)after=after.replace(re,to);
    if(after!==before){JSON.parse(after);fs.writeFileSync(full,after);changed++;}
  }
}
console.log(`brand-nls: ${changed} files`);
