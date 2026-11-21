// Removes upstream product names from installed language pack translations (display text only).
'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=process.argv[2];let changed=0;
const map=[[/Açık \(Visual Studio\)/g,'Açık Klasik'],[/Koyu \(Visual Studio\)/g,'Koyu Klasik'],[/\(VSCodium\)/g,'Klasik'],[/Visual Studio Code/g,'Cude IDE'],[/VS Code/g,'Cude IDE'],[/VSCodium/g,'Cude IDE'],[/Visual Studio/g,'Cude IDE']];
const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory())walk(f);else if(f.endsWith('.json')){const b=fs.readFileSync(f,'utf8');let a=b;for(const [r,t] of map)a=a.replace(r,t);if(a!==b){JSON.parse(a);fs.writeFileSync(f,a);changed++;}}}};
for(const dir of fs.readdirSync(root).filter(n=>n.startsWith('ms-ceintl.vscode-language-pack-')))walk(path.join(root,dir,'translations'));
console.log('brand-langpack:',changed,'files');
