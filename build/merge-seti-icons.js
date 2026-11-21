// Cude icon theme = Seti file glyphs (MIT, shipped with the editor) + Cude folder icons.
'use strict';
const fs=require('node:fs'),path=require('node:path');
const app=process.argv[2];const ext=path.join(__dirname,'..','extensions','cude-ai');
const setiDir=path.join(app,'extensions','theme-seti','icons');
const seti=JSON.parse(fs.readFileSync(path.join(setiDir,'vs-seti-icon-theme.json'),'utf8'));
fs.copyFileSync(path.join(setiDir,'seti.woff'),path.join(ext,'themes','seti.woff'));
const cude=JSON.parse(fs.readFileSync(path.join(ext,'themes','cude-icons.json'),'utf8'));
const folderDefs=Object.fromEntries(Object.entries(cude.iconDefinitions).filter(([k])=>k.startsWith('d_')||k.startsWith('_folder')));
const theme={fonts:[{...seti.fonts[0],src:[{path:'./seti.woff',format:'woff'}]}],iconDefinitions:{...seti.iconDefinitions,...folderDefs},
 file:seti.file,fileExtensions:seti.fileExtensions,fileNames:seti.fileNames,languageIds:seti.languageIds,
 folder:'_folder',folderExpanded:'_folderOpen',rootFolder:'_folder',rootFolderExpanded:'_folderOpen',folderNames:cude.folderNames,folderNamesExpanded:cude.folderNamesExpanded,
 light:{...seti.light,folder:'_folder',folderExpanded:'_folderOpen',rootFolder:'_folder',rootFolderExpanded:'_folderOpen',folderNames:cude.folderNames,folderNamesExpanded:cude.folderNamesExpanded},hidesExplorerArrows:false};
fs.writeFileSync(path.join(ext,'themes','cude-icons.json'),JSON.stringify(theme));
console.log('defs',Object.keys(theme.iconDefinitions).length,'ext',Object.keys(theme.fileExtensions).length);
