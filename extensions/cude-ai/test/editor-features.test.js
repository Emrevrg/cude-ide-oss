const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const originalLoad = Module._load;
Module._load = function(request,parent,isMain){return request==='vscode'?{}:originalLoad.call(this,request,parent,isMain);};
const {isProtectedCompletionPath,extractCompletion,changedDiffLines}=require(path.join(__dirname,'..','out','editorFeatures.js'));
Module._load = originalLoad;

test('0g never sends hidden or secret workspace files to inline completion',()=>{
  const root='E:\\workspace';
  for(const relative of ['.env','.env.local','.ssh/config','.cude/rules.md','secrets/token.txt','src/private.key','../outside.ts'])assert.equal(isProtectedCompletionPath(path.join(root,relative),root),true,relative);
  for(const relative of ['src/main.ts','packages/app/index.tsx','README.md'])assert.equal(isProtectedCompletionPath(path.join(root,relative),root),false,relative);
});

test('0g completion cleanup keeps code indentation and removes model fences',()=>{
  assert.equal(extractCompletion('```ts\n  return value;\n```'),'  return value;');
  assert.equal(extractCompletion('  return value;\n'),'  return value;');
  assert.equal(extractCompletion(''), '');
});

test('review comment line mapping accepts only added or changed diff lines',()=>{
  const changed=changedDiffLines('diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra\n');
  assert.deepEqual([...changed.get('src/a.ts')],[2,3]);
});
