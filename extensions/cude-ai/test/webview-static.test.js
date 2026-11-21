const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');

// Catches runtime-only webview bugs (const reassignment, undeclared names, syntax) before a release.
for(const file of ['chat.html','providers.html']){
  test(`${file} script has no constant reassignment or syntax errors`,()=>{
    const html=fs.readFileSync(path.join(__dirname,'..','media',file),'utf8');
    const js=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n')
      .replace(/\{\{I18N\}\}/g,'{}').replace(/\{\{[A-Z_0-9]+\}\}/g,'null');
    const name=path.join(require('node:os').tmpdir(),`cude-webview-${file}.js`);
    const host=ts.createCompilerHost({});
    const original=host.getSourceFile;
    host.getSourceFile=(f,lang,...rest)=>f===name?ts.createSourceFile(f,js,lang,true):original(f,lang,...rest);
    host.fileExists=(f=>f===name||ts.sys.fileExists(f));
    host.readFile=(f=>f===name?js:ts.sys.readFile(f));
    const program=ts.createProgram([name],{allowJs:true,checkJs:true,noEmit:true,target:ts.ScriptTarget.ES2022,lib:['lib.es2022.d.ts','lib.dom.d.ts']},host);
    const fatal=new Set([2588,2630,2304,2448,2454,1005,1109,1128,1136]);
    const allowed=/acquireVsCodeApi/;
    const errors=[...program.getSyntacticDiagnostics(),...program.getSemanticDiagnostics()]
      .filter(d=>d.file&&d.file.fileName===name&&fatal.has(d.code))
      .map(d=>`${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText,' ')}`)
      .filter(text=>!allowed.test(text));
    assert.deepEqual(errors,[]);
  });
}
