const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
class TestWorkspaceEdit { constructor(){this.ops=[];} replace(uri,range,text){this.ops.push({type:'replace',uri,text});} createFile(uri){this.ops.push({type:'create',uri});} insert(uri,position,text){this.ops.push({type:'insert',uri,text});} }
class TestPosition { constructor(line,character){this.line=line;this.character=character;} }
class TestRange { constructor(start,end){this.start=start;this.end=end;} }

class Memento {
  constructor(values = new Map()) { this.values = values; }
  get(key, fallback) { return this.values.has(key) ? this.values.get(key) : fallback; }
  async update(key, value) { this.values.set(key, value); }
}

const vscode = {
  workspace: {
    isTrusted: true,
    workspaceFolders: [],
    findFiles: async () => [],
    fs: {
      readFile: async uri => fs.promises.readFile(uri.fsPath),
      writeFile: async (uri, value) => fs.promises.writeFile(uri.fsPath, value),
    },
    openTextDocument: async document => ({ uri: document.uri || document, getText: () => document.content || '' }),
  },
  window: {},
  commands: { executeCommand: async () => undefined },
  WorkspaceEdit:TestWorkspaceEdit,Position:TestPosition,Range:TestRange,EndOfLine:{LF:1,CRLF:2},
  Uri:{file:fsPath=>({fsPath,path:fsPath,toString:()=>fsPath}),parse:value=>({path:new URL(value).pathname,fsPath:value,toString:()=>value})},
  FileType: { File: 1 },
};
const extensionPath = path.join(__dirname, '..', 'out', 'extension.js');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
const { appendProjectMemory, applySearchReplaceBlocks, createAgentWorktree, CudeChatView, CudeCore, makeSpec, persistChatSession } = require(extensionPath);
Module._load = originalLoad;

function tempFixture(label) {
  const temp = path.resolve(process.env.CUDE_TEST_TMP || 'E:\\rust\\tmp');
  fs.mkdirSync(temp, { recursive: true });
  const folder = fs.mkdtempSync(path.join(temp, `cude-${label}-`));
  assert.ok(path.resolve(folder).startsWith(temp + path.sep), 'fixtures must stay under the E: temporary root');
  return { temp, folder };
}

function cleanFixture(fixture) {
  const resolved = path.resolve(fixture.folder);
  assert.ok(resolved.startsWith(path.resolve(fixture.temp) + path.sep), 'only delete the fixture created by this test');
  fs.rmSync(resolved, { recursive: true, force: true });
}

test('conversation history and project memory persist in their intended stores', async () => {
  const fixture = tempFixture('persistence');
  try {
    const values = new Map();
    const firstRun = new Memento(values);
    await persistChatSession(firstRun, 'chat-persist-1', 'project-fixture', [
      { role: 'user', content: 'Explain the repository' },
      { role: 'assistant', content: 'It contains a small app.' },
    ]);
    const restartedRun = new Memento(values);
    const history = restartedRun.get('chatSessions', []);
    assert.equal(history.length, 1);
    assert.equal(history[0].title, 'Explain the repository');
    assert.equal(history[0].messages.length, 2);

    vscode.workspace.isTrusted = true;
    const memoryFile = await appendProjectMemory(fixture.folder, 'Keep API compatibility', new Date('2026-11-18T00:00:00Z'));
    const nextMemoryRead = await fs.promises.readFile(path.join(fixture.folder, '.cude', 'memory.md'), 'utf8');
    assert.equal(memoryFile, path.join(fixture.folder, '.cude', 'memory.md'));
    assert.match(nextMemoryRead, /## Session 2026-11-18\n\nKeep API compatibility/);
  } finally { cleanFixture(fixture); }
});

test('CudeCore wrapper uses the shipped process for ping, file search, and secret-safe grep', async () => {
  const fixture = tempFixture('core-wrapper');
  const src = path.join(fixture.folder, 'src');
  const secrets = path.join(fixture.folder, 'secrets');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(secrets, { recursive: true });
  fs.writeFileSync(path.join(src, 'main.rs'), 'fn cude_wrapper_marker() { /* cude-wrapper-marker */ }\n');
  fs.writeFileSync(path.join(secrets, 'token.txt'), 'cude-wrapper-marker=must-not-leak\n');
  const core = new CudeCore(path.join(__dirname, '..', 'bin', 'cude-core.exe'));
  try {
    const ping = await core.call('ping', { root: fixture.folder });
    assert.equal(ping.ok, true);
    assert.equal(ping.version, '0.1.0');

    const files = await core.call('find_files', { root: fixture.folder, query: 'main.rs', limit: 10 });
    assert.ok(files.includes('src/main.rs'));

    const matches = await core.call('grep', { root: fixture.folder, pattern: 'cude-wrapper-marker', limit: 10, ignore_case: true });
    assert.ok(matches.some(match => match.file === 'src/main.rs' && match.text.includes('cude-wrapper-marker')));
    assert.ok(matches.every(match => !match.file.toLowerCase().includes('secret') && !match.text.includes('must-not-leak')));
  } finally {
    core.dispose();
    cleanFixture(fixture);
  }
});

test('Plan mode writes a structured spec into the project and opens it', async () => {
  const fixture = tempFixture('spec');
  try {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: fixture.folder } }];
    vscode.workspace.isTrusted = true;
    let opened;
    vscode.Uri.file = fsPath => ({ fsPath, toString: () => fsPath });
    vscode.workspace.openTextDocument = async uri => { opened = uri.fsPath; return { uri }; };
    vscode.window.showTextDocument = async () => undefined;
    const gateway = { chat: async messages => {
      assert.match(messages[0].content, /# Requirements/);
      return '# Requirements\n- The user can search files.\n\n# Design\nUse a bounded project index.\n\n# Tasks\n- [ ] Add a search command.\n';
    } };
    const file = await makeSpec(gateway, 'Search project files');
    const content = await fs.promises.readFile(file, 'utf8');
    assert.equal(opened, file);
    assert.match(content, /# Requirements/);
    assert.match(content, /# Design/);
    assert.match(content, /# Tasks\n- \[ \]/);
  } finally {
    vscode.workspace.workspaceFolders = [];
    cleanFixture(fixture);
  }
});

test('permission modes persist, enforce read-only, and allow Auto without an approval prompt', async () => {
  const fixture = tempFixture('permissions');
  const warnings = [];
  const commands = [];
  try {
    const sourceDir = path.join(fixture.folder, 'src');
    fs.mkdirSync(sourceDir, { recursive: true });
    const sourceFile = path.join(sourceDir, 'value.ts');
    fs.writeFileSync(sourceFile, 'export const value = "before";\n');
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: fixture.folder } }];
    vscode.workspace.isTrusted = true;
    vscode.window.showWarningMessage = async (...args) => { warnings.push(args); return 'Apply'; };
    vscode.commands.executeCommand = async (...args) => { commands.push(args); };
    vscode.Uri.file = fsPath => ({ fsPath, toString: () => fsPath });
    const docs=new Map();const openDocument=async uri=>{const file=uri.fsPath||uri;if(!docs.has(file)){const text=await fs.promises.readFile(file,'utf8');docs.set(file,{uri:{fsPath:file},text,version:1,eol:1,getText(){return this.text;},positionAt(offset){return new TestPosition(0,offset);}});}return docs.get(file);};
    vscode.workspace.openTextDocument=openDocument;let editCalls=0;vscode.workspace.applyEdit=async edit=>{editCalls++;for(const op of edit.ops){const file=op.uri.fsPath;if(op.type==='create'){await fs.promises.mkdir(path.dirname(file),{recursive:true});await fs.promises.writeFile(file,'');docs.set(file,{uri:op.uri,text:'',version:1,eol:1,getText(){return this.text;},positionAt(offset){return new TestPosition(0,offset);}});}else if(op.type==='insert'){const doc=await openDocument(op.uri);doc.text=op.text;doc.version++;await fs.promises.writeFile(file,doc.text);}else if(op.type==='replace'){const doc=await openDocument(op.uri);const bom=doc.text.startsWith('\uFEFF');doc.text=(bom&&!op.text.startsWith('\uFEFF')?'\uFEFF':'')+op.text;doc.version++;if(!doc.isDirty)await fs.promises.writeFile(file,doc.text);}}return true;};vscode.window.showTextDocument=async document=>document;
    const workspaceState = new Memento(new Map([['agents', [{ id: 'agent-1', title: 'Update value', status: 'done', steps: [{ id: 'step-1', title: 'Edit value', kind: 'file', path: 'src/value.ts', content: 'export const value = "after";\n' }] }]]]));
    const messages = [];
    const view = new CudeChatView({ workspaceState, globalState: new Memento() }, { setModelRefresh() {} }, {});
    view.webview = { postMessage: message => messages.push(message) };

    await view.handle({ type: 'permission', value: 'readonly' });
    assert.equal(workspaceState.get('permission'), 'readonly');
    await view.handle({ type: 'approveStep', agentId: 'agent-1', stepId: 'step-1', permission: 'readonly' });
    assert.match(messages.at(-1).text, /Read-only mode/);
    assert.match(await fs.promises.readFile(sourceFile, 'utf8'), /before/);

    await view.handle({type:'permission',value:'ask'});await view.handle({type:'approveStep',agentId:'agent-1',stepId:'step-1',permission:'ask'});const staged=messages.find(message=>message.type==='pendingChange');assert.ok(staged,'agent file approval is staged for an inline decision');assert.deepEqual(staged.files,[{path:'src/value.ts',added:1,removed:1}]);assert.equal(warnings.length,0,'file approval does not open a native modal');assert.match(await fs.promises.readFile(sourceFile,'utf8'),/before/,'Ask mode does not write before acceptance');await view.handle({type:'acceptChange',path:'src/value.ts'});assert.match(docs.get(sourceFile).getText(),/after/);assert.deepEqual(workspaceState.get('agents')[0].artifacts,['src/value.ts']);

    await view.handle({ type: 'permission', value: 'auto' });
    assert.equal(workspaceState.get('permission'), 'auto');
    await view.handle({ type: 'approveStep', agentId: 'agent-1', stepId: 'step-1', permission: 'auto' });
    assert.match(docs.get(sourceFile).getText(), /after/);
    assert.equal(warnings.length, 0, 'Auto mode must not wait for a second confirmation');
    assert.equal(editCalls,2,'each accepted agent file change is a single WorkspaceEdit transaction');
    assert.ok(commands.some(args => args[0] === 'vscode.diff'));
    assert.ok(messages.some(message => message.type === 'changes'));
  } finally {
    vscode.workspace.workspaceFolders = [];
    cleanFixture(fixture);
  }
});

test('Cude worktree command creates an isolated Git branch only after the confirmation gate', async () => {
  const fixture = tempFixture('worktree');
  const repository = path.join(fixture.folder, 'repo');
  const parent = path.join(fixture.folder, 'agents');
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(parent, { recursive: true });
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  try {
    git(['init', '-b', 'main'], repository);
    fs.writeFileSync(path.join(repository, 'README.md'), '# worktree fixture\n');
    git(['add', 'README.md'], repository);
    git(['-c', 'user.name=Cude Test', '-c', 'user.email=cude-test@example.invalid', 'commit', '-m', 'fixture'], repository);
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: repository } }];
    vscode.workspace.isTrusted = true;
    let confirmationCount = 0;
    vscode.window.showOpenDialog = async () => [{ fsPath: parent }];
    vscode.window.showWarningMessage = async () => { confirmationCount++; return 'Create worktree'; };
    vscode.window.showInformationMessage = async () => 'Later';
    await createAgentWorktree();

    assert.equal(confirmationCount, 1);
    const entries = fs.readdirSync(parent);
    assert.equal(entries.length, 1);
    const destination = path.join(parent, entries[0]);
    assert.ok(fs.existsSync(path.join(destination, 'README.md')));
    const worktrees = git(['worktree', 'list', '--porcelain'], repository);
    assert.ok(worktrees.includes(destination.replace(/\\/g, '/')) || worktrees.includes(destination));
    assert.match(worktrees, /branch refs\/heads\/cude\/agent-/);
  } finally {
    vscode.workspace.workspaceFolders = [];
    cleanFixture(fixture);
  }
});

test('0d proposals stay in memory and apply three dirty/CRLF/BOM/Turkish-path files atomically with one undo',async()=>{
  const fixture=tempFixture('proposal-acceptance');try{
    const files=[['src/crlf.ts','export const a = 1;\r\n'],['src/bom.ts','\uFEFFexport const b = 1;\n'],['src/çok şey.ts','export const c = 1;\n']];
    for(const [relative,content] of files){const target=path.join(fixture.folder,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content,'utf8');}
    vscode.workspace.workspaceFolders=[{uri:{fsPath:fixture.folder}}];vscode.workspace.isTrusted=true;vscode.Uri.file=fsPath=>({fsPath,toString:()=>fsPath});
    const docs=new Map();const openDocument=async input=>{if(input&&input.content!==undefined)return{uri:input,text:input.content,version:1,eol:1,isDirty:false,getText(){return this.text;},positionAt(offset){return new TestPosition(0,offset);}};const file=input.fsPath||input;if(!docs.has(file)){const text=await fs.promises.readFile(file,'utf8');docs.set(file,{uri:{fsPath:file},text,version:1,eol:text.includes('\r\n')?2:1,isDirty:false,getText(){return this.text;},positionAt(offset){return new TestPosition(0,offset);}});}return docs.get(file);};
    vscode.workspace.openTextDocument=openDocument;let editCalls=0;vscode.workspace.applyEdit=async edit=>{editCalls++;for(const op of edit.ops){const file=op.uri.fsPath;if(op.type==='create'){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'');docs.set(file,{uri:op.uri,text:'',version:1,eol:1,isDirty:false,getText(){return this.text;},positionAt(offset){return new TestPosition(0,offset);}});}else if(op.type==='insert'){const doc=await openDocument(op.uri);doc.text=op.text;doc.version++;await fs.promises.writeFile(file,doc.text);}else if(op.type==='replace'){const doc=await openDocument(op.uri),bom=doc.text.startsWith('\uFEFF');doc.text=(bom&&!op.text.startsWith('\uFEFF')?'\uFEFF':'')+op.text;doc.version++;if(!doc.isDirty)await fs.promises.writeFile(file,doc.text);}}return true;};vscode.window.showTextDocument=async doc=>doc;vscode.window.showWarningMessage=async()=> 'Tümünü uygula';vscode.commands.executeCommand=async()=>undefined;
    const steps=files.map(([relative],i)=>({id:`proposal-${i}`,kind:'file',title:`Dosya ${i}`,path:relative,content:`export const value${i} = ${i+2};\n`}));
    const ws=new Memento(new Map([['agents',[{id:'batch',title:'Üç dosya',status:'done',steps}]]]));const messages=[],view=new CudeChatView({workspaceState:ws,globalState:new Memento()}, {setModelRefresh(){}},{});view.webview={postMessage:message=>messages.push(message)};
    const dirty=await openDocument(path.join(fixture.folder,files[2][0]));dirty.text='export const c = "unsaved buffer";\n';dirty.version=7;dirty.isDirty=true;
    await view.handle({type:'permission',value:'auto'});await view.handle({type:'approveAll',agentId:'batch',permission:'auto'});assert.equal(editCalls,1,'all three paths apply in one WorkspaceEdit');assert.equal(messages.filter(m=>m.type==='changes').length,1);
    assert.match(docs.get(path.join(fixture.folder,'src/crlf.ts')).getText(),/\r\n/,'CRLF line endings are kept');assert.ok(docs.get(path.join(fixture.folder,'src/bom.ts')).getText().startsWith('\uFEFF'),'UTF-8 BOM is kept');assert.match(dirty.getText(),/value2/,'dirty editor buffer receives the accepted change');assert.match(await fs.promises.readFile(path.join(fixture.folder,files[2][0]),'utf8'),/c = 1/,'accepting a dirty buffer does not write over the disk version');
    await view.handle({type:'undo'});assert.equal(editCalls,2,'undo restores the whole batch in one WorkspaceEdit');assert.match(docs.get(path.join(fixture.folder,'src/crlf.ts')).getText(),/a = 1/);assert.ok(docs.get(path.join(fixture.folder,'src/bom.ts')).getText().startsWith('\uFEFF'));
    const newPath='yeni klasör/şablon.ts';await view.handle({type:'applyBlock',path:newPath,content:'export const ready = true;\n',permission:'auto'});assert.ok(fs.existsSync(path.join(fixture.folder,newPath)),'a new file and nested folder are created on acceptance');const existing='src/already.ts';fs.mkdirSync(path.dirname(path.join(fixture.folder,existing)),{recursive:true});fs.writeFileSync(path.join(fixture.folder,existing),'keep me\n');await view.handle({type:'newFile',path:existing,content:'replace me\n',permission:'auto'});assert.match(await fs.promises.readFile(path.join(fixture.folder,existing),'utf8'),/^keep me/,'New file never overwrites an existing destination');assert.ok(messages.some(message=>message.type==='error'&&message.text.includes('already exists')),'an existing New file destination is rejected visibly');
    assert.throws(()=>applySearchReplaceBlocks('alpha\nbeta\n','<<<<<<< SEARCH\nabsent\n=======\nreplacement\n>>>>>>> REPLACE'),/did not match exactly once/,'missing search text never silently overwrites');assert.equal(applySearchReplaceBlocks('alpha\nbeta\n','<<<<<<< SEARCH\nbeta\n=======\ngamma\n>>>>>>> REPLACE'),'alpha\ngamma\n');
  }finally{vscode.workspace.workspaceFolders=[];cleanFixture(fixture);}
});

test('0d Ask mode uses an inline batch decision and applies all three files in one WorkspaceEdit',async()=>{
  const fixture=tempFixture('proposal-inline-batch');try{
    vscode.workspace.workspaceFolders=[{uri:{fsPath:fixture.folder}}];vscode.workspace.isTrusted=true;vscode.Uri.file=fsPath=>({fsPath,toString:()=>fsPath});
    const docs=new Map(),openDocument=async input=>{if(input&&input.content!==undefined)return{uri:input.uri,text:input.content,version:1,eol:1,getText(){return this.text;},positionAt(offset){return new TestPosition(0,offset);}};const file=input.fsPath||input;if(!docs.has(file)){const text=await fs.promises.readFile(file,'utf8');docs.set(file,{uri:{fsPath:file},text,version:1,eol:1,getText(){return this.text;},positionAt(offset){return new TestPosition(0,offset);}});}return docs.get(file);};
    vscode.workspace.openTextDocument=openDocument;let editCalls=0,modalCalls=0;vscode.window.showWarningMessage=async()=>{modalCalls++;return 'Tümünü uygula';};vscode.commands.executeCommand=async()=>undefined;vscode.window.showTextDocument=async doc=>doc;
    vscode.workspace.applyEdit=async edit=>{editCalls++;for(const op of edit.ops){if(op.type==='create'){await fs.promises.mkdir(path.dirname(op.uri.fsPath),{recursive:true});await fs.promises.writeFile(op.uri.fsPath,'');docs.set(op.uri.fsPath,{uri:op.uri,text:'',version:1,eol:1,getText(){return this.text;},positionAt(offset){return new TestPosition(0,offset);}});}else if(op.type==='insert'){const doc=await openDocument(op.uri);doc.text=op.text;await fs.promises.writeFile(op.uri.fsPath,op.text);}}return true;};
    const steps=['bir.ts','iki.ts','üç.ts'].map((name,index)=>({id:`step-${index}`,kind:'file',title:name,path:`nested/${name}`,content:`export const n = ${index};\n`})),ws=new Memento(new Map([['permission','ask'],['agents',[{id:'agent-inline',title:'Üç dosyalı değişiklik',status:'done',steps}]]]));const messages=[],view=new CudeChatView({workspaceState:ws,globalState:new Memento()},{setModelRefresh(){}},{});view.webview={postMessage:message=>messages.push(message)};
    await view.handle({type:'approveAll',agentId:'agent-inline',permission:'ask'});const staged=messages.find(message=>message.type==='pendingChange');assert.ok(staged,'Ask mode presents a pending-change event');assert.equal(staged.files.length,3);for(const file of staged.files)assert.deepEqual(Object.keys(file).sort(),['added','path','removed']);assert.equal(editCalls,0,'nothing is written before inline acceptance');assert.equal(modalCalls,0,'batch approval does not open a native modal');
    await view.handle({type:'acceptChange'});assert.equal(editCalls,1,'acceptChange without path applies all three as one WorkspaceEdit');for(const step of steps)assert.ok(fs.existsSync(path.join(fixture.folder,step.path)),`${step.path} was created`);assert.deepEqual(ws.get('agents')[0].artifacts,['nested/bir.ts','nested/iki.ts','nested/üç.ts']);assert.equal(messages.filter(message=>message.type==='changes').length,1);
  }finally{vscode.workspace.workspaceFolders=[];cleanFixture(fixture);}
});

test('0d reports a conflict when an open document changes after diff staging',async()=>{
  const fixture=tempFixture('proposal-conflict');try{const file=path.join(fixture.folder,'src','conflict.ts');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'before\n');vscode.workspace.workspaceFolders=[{uri:{fsPath:fixture.folder}}];vscode.workspace.isTrusted=true;vscode.Uri.file=fsPath=>({fsPath,toString:()=>fsPath});const doc={uri:{fsPath:file},text:'before\n',version:2,eol:1,getText(){return this.text;},positionAt(offset){return new TestPosition(0,offset);}};vscode.workspace.openTextDocument=async input=>input?.content!==undefined?{uri:input,text:input.content,version:1,eol:1,getText(){return this.text;},positionAt(offset){return new TestPosition(0,offset);}}:doc;vscode.commands.executeCommand=async()=>undefined;vscode.workspace.applyEdit=async()=>{throw new Error('conflict must not apply');};const messages=[],view=new CudeChatView({workspaceState:new Memento(),globalState:new Memento()},{setModelRefresh(){}},{});view.webview={postMessage:message=>messages.push(message)};await view.handle({type:'previewBlock',path:'src/conflict.ts',content:'after\n'});assert.ok(messages.find(m=>m.type==='pendingChange'));doc.version++;await view.handle({type:'acceptChange',path:'src/conflict.ts'});assert.ok(messages.some(m=>m.type==='error'&&/editor content changed/.test(m.text)),'stale editor version is rejected with a visible conflict');}finally{vscode.workspace.workspaceFolders=[];cleanFixture(fixture);}
});

test('0d detects same-size disk edits even when the modification timestamp is restored',async()=>{
  const fixture=tempFixture('proposal-disk-conflict');try{
    const file=path.join(fixture.folder,'src','same-size.ts');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'const x = 1;\n');const originalStat=fs.statSync(file);
    vscode.workspace.workspaceFolders=[{uri:{fsPath:fixture.folder}}];vscode.workspace.isTrusted=true;vscode.Uri.file=fsPath=>({fsPath,toString:()=>fsPath});
    const doc={uri:{fsPath:file},text:'const x = 1;\n',version:1,eol:1,getText(){return this.text;},positionAt(offset){return new TestPosition(0,offset);}};
    vscode.workspace.openTextDocument=async input=>input?.content!==undefined?{uri:input,text:input.content,version:1,eol:1,getText(){return this.text;},positionAt(offset){return new TestPosition(0,offset);}}:doc;
    vscode.commands.executeCommand=async()=>undefined;vscode.workspace.applyEdit=async()=>{throw new Error('disk conflict must not apply');};
    const messages=[],view=new CudeChatView({workspaceState:new Memento(),globalState:new Memento()},{setModelRefresh(){}},{});view.webview={postMessage:message=>messages.push(message)};
    await view.handle({type:'previewBlock',path:'src/same-size.ts',content:'const x = 2;\n'});assert.ok(messages.find(message=>message.type==='pendingChange'));
    fs.writeFileSync(file,'const x = 3;\n');fs.utimesSync(file,originalStat.atime,originalStat.mtime);
    await view.handle({type:'acceptChange',path:'src/same-size.ts'});assert.ok(messages.some(message=>message.type==='error'&&/changed on disk outside Cude/.test(message.text)),'content hash catches changes that size/mtime stamps can miss');
  }finally{vscode.workspace.workspaceFolders=[];cleanFixture(fixture);}
});

test('Agents review applies accepted worktree files atomically and records file-level rejections',async()=>{
  const fixture=tempFixture('agents-review');try{
    const main=path.join(fixture.folder,'main'),worktree=path.join(fixture.folder,'worktree');fs.mkdirSync(main,{recursive:true});fs.mkdirSync(path.join(worktree,'src'),{recursive:true});
    vscode.workspace.workspaceFolders=[{uri:{fsPath:main}}];vscode.workspace.isTrusted=true;vscode.Uri.file=fsPath=>({fsPath,path:fsPath,toString:()=>fsPath});
    const docs=new Map(),openDocument=async input=>{if(input&&input.content!==undefined)return{uri:input,text:input.content,version:1,eol:1,isDirty:false,getText(){return this.text;},positionAt(offset){return new TestPosition(0,offset);}};const file=input.fsPath||input;if(!docs.has(file)){const text=await fs.promises.readFile(file,'utf8');docs.set(file,{uri:{fsPath:file},text,version:1,eol:1,isDirty:false,getText(){return this.text;},positionAt(offset){return new TestPosition(0,offset);}});}return docs.get(file);};
    vscode.workspace.openTextDocument=openDocument;vscode.commands.executeCommand=async()=>undefined;let editCalls=0;vscode.workspace.applyEdit=async edit=>{editCalls++;for(const op of edit.ops){const file=op.uri.fsPath;if(op.type==='create'){await fs.promises.mkdir(path.dirname(file),{recursive:true});await fs.promises.writeFile(file,'');docs.set(file,{uri:op.uri,text:'',version:1,eol:1,isDirty:false,getText(){return this.text;},positionAt(offset){return new TestPosition(0,offset);}});}else if(op.type==='insert'){const doc=await openDocument(op.uri);doc.text=op.text;doc.version++;await fs.promises.writeFile(file,doc.text);}}return true;};
    const agent={id:'worktree-agent',title:'Three files',status:'done',workspacePath:worktree,permission:'ask',steps:['bir','iki','üç'].map(name=>({id:name,kind:'file',title:name,path:`src/${name}.ts`,content:`export const ${name} = true;\n`}))},state=new Memento(new Map([['agents',[agent]]])),agents={list:()=>state.get('agents'),update:async next=>state.update('agents',[next])},view=new CudeChatView({workspaceState:state,globalState:new Memento()}, {setModelRefresh(){}}, agents);
    await view.reviewAgent(agent.id,'src/bir.ts',false);assert.deepEqual(state.get('agents')[0].rejectedFiles,['src/bir.ts']);assert.equal(editCalls,0,'reject is file scoped and does not write');
    await view.reviewAgent(agent.id,undefined,true);assert.equal(editCalls,1,'accept all applies one WorkspaceEdit');for(const step of agent.steps)assert.ok(fs.existsSync(path.join(worktree,step.path)),`${step.path} was written to its selected worktree`);assert.ok(!fs.existsSync(path.join(main,'src','bir.ts')),'worktree proposals never leak into the main checkout');assert.equal(state.get('agents')[0].acceptedFiles.length,3);assert.deepEqual(state.get('agents')[0].rejectedFiles,[]);
  }finally{vscode.workspace.workspaceFolders=[];cleanFixture(fixture);}
});
