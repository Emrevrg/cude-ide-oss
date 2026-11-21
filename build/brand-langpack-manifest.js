// Gives the bundled language pack a Cude display name (no upstream product names in the Extensions view).
'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=process.argv[2];
for(const dir of fs.readdirSync(root).filter(n=>n.startsWith('ms-ceintl.vscode-language-pack-tr'))){
  const f=path.join(root,dir,'package.json');const p=JSON.parse(fs.readFileSync(f,'utf8'));
  p.displayName='Cude IDE Türkçe';p.description='Cude IDE arayüzü için Türkçe dil paketi';
  fs.writeFileSync(f,JSON.stringify(p,null,2));
  for(const doc of ['readme.md','changelog.md']){const d=path.join(root,dir,doc);if(fs.existsSync(d))fs.writeFileSync(d,'# Cude IDE Türkçe\n\nCude IDE arayüzü için Türkçe dil paketi. Kaynak: Microsoft dil paketi (MIT).\n');}
  console.log('branded',dir);
}
