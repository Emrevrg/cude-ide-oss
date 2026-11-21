const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const chat = fs.readFileSync(path.join(root, 'media', 'chat.html'), 'utf8');
const agentsHtml=fs.readFileSync(path.join(root,'media','agents.html'),'utf8');
const {I18N}=require(path.join(root,'out','i18n.js'));
const prepareWebviewScript=(html,pattern)=>html.match(pattern)?.[1]?.replaceAll('{{LANG}}','en').replaceAll('{{I18N}}',JSON.stringify(I18N));

test('Cude AI extension has a valid release manifest and activation entry point', () => {
  assert.equal(pkg.name, 'cude-ai'); assert.match(pkg.version, /^\d+\.\d+\.\d+$/); assert.equal(pkg.main, './out/extension.js');
  assert.deepEqual(pkg.extensionKind, ['ui']);
});

test('0f English default, bilingual UI strings, and delayed-webview readiness are wired',()=>{
  assert.equal(pkg.contributes.configuration.properties['cude-ai.language'].default,'en');
  assert.deepEqual(Object.keys(I18N.en).sort(),Object.keys(I18N.tr).sort());
  assert.ok(pkg.contributes.commands.some(command=>command.command==='cude-ai.changeLanguage'&&command.title==='Cude: Change Language'));
  assert.match(source,/cude-ai\.language/);assert.match(source,/workbench\.action\.configureLocale/);
  assert.match(source,/webviewReady=true/);assert.match(source,/if\(firstReady\)setImmediate\(\(\)=>void this\.gateway\.prepareStartupModels\(\)\)/);
  assert.doesNotMatch(chat,/<nav class="modes"/);
  for(const view of [chat,agentsHtml]){
    for(const key of [...view.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)].map(match=>match[1]))assert.ok(I18N.en[key],`missing locale key ${key}`);
    for(const key of [...view.matchAll(/\bt\('([^']+)'/g)].map(match=>match[1])){
      if(key.endsWith('.'))assert.ok(Object.keys(I18N.en).some(candidate=>candidate.startsWith(key)),`missing locale key prefix ${key}`);
      else assert.ok(I18N.en[key],`missing locale key ${key}`);
    }
  }
  for(const level of ['ask','auto','plan','full'])assert.ok(chat.includes(`value: '${level}'`)||chat.includes(`value:'${level}'`),`missing ${level} permission`);
  assert.match(agentsHtml,/<option value="full"/);
});

test('0g editor AI contributes guarded Tab completion, inline edit, project rules, and review comments',()=>{
  const features=fs.readFileSync(path.join(root,'src','editorFeatures.ts'),'utf8');
  assert.match(features,/registerInlineCompletionItemProvider/);assert.match(features,/setTimeout\(resolve,250\)/);
  assert.match(features,/<\|fim_prefix\|>/);assert.match(features,/<\|fim_suffix\|>/);assert.match(features,/<\|fim_middle\|>/);
  assert.match(features,/CancellationRequested/);assert.match(features,/isProtectedCompletionPath/);
  assert.match(features,/workspace\.applyEdit\(workspaceEdit\)/);assert.match(features,/comments\?\.createCommentController/);
  assert.match(source,/Project rules from \.cude\/rules\.md/);assert.match(source,/async function readProjectRules/);
  assert.ok(chat.includes("name: '/rules'"));
  for(const key of ['cude-ai.inlineCompletion.enabled','cude-ai.inlineCompletion.providerId','cude-ai.inlineCompletion.model'])assert.ok(pkg.contributes.configuration.properties[key]);
  for(const id of ['editSelection','toggleInlineCompletion','acceptInlineEdit','rejectInlineEdit','retryInlineEdit','reviewChanges'])assert.ok(pkg.contributes.commands.some(item=>item.command===`cude-ai.${id}`),id);
  assert.ok(pkg.contributes.keybindings.some(item=>item.command==='cude-ai.editSelection'&&item.key==='ctrl+i'));
  assert.ok(pkg.contributes.keybindings.some(item=>item.command==='cude-ai.acceptInlineEdit'&&item.key==='ctrl+enter'));
});

test('provider credentials use SecretStorage and supports all requested providers', () => {
  assert.match(source, /SecretStorage/); assert.ok(source.includes('writeProviderCredentials(this.secrets,profile,'));
  assert.match(source, /ConfigurationTarget\.Global/); assert.match(source, /requireTrustedWorkspace/);
  assert.match(source, /validateProviderBase/); assert.match(source, /x-goog-api-key/);
  assert.match(source, /private async discover/); assert.match(source, /Bağlantıyı test et/);
  assert.match(source, /providers\.json dışa aktar/); assert.match(source, /providers\.json içe aktar/);
  const presetSource=fs.readFileSync(path.join(root,'src','providerPresets.ts'),'utf8');
  const presets=[...presetSource.matchAll(/\{id:'([^']+)',name:'([^']+)',provider:'([^']+)',baseUrl:'([^']+)',auth:'(bearer|anthropic|gemini|azure|none)'/g)];
  assert.ok(presets.length>=40,`expected at least 40 curated provider presets; got ${presets.length}`);
  assert.equal(presets[0][1],'norovox','Norovox is the first provider preset');
  for(const row of presets){assert.ok(['https:','http:'].some(protocol=>row[4].startsWith(protocol)),row[1]);if(row[4].startsWith('http:'))assert.match(row[4],/^http:\/\/(localhost|127\.0\.0\.1)/,row[1]);}
  assert.match(source,/headers\['api-key'\]=key/,'Azure OpenAI uses its API-key header');assert.match(source,/headers\['x-api-key'\]=key/,'Anthropic uses its API-key header');assert.match(source,/headers\['x-goog-api-key'\]=key/,'Gemini uses its API-key header');
  assert.match(source, /models=await this\.discover/);
  assert.match(source, /tr\('provider\.noModelSelected'\)/); assert.match(I18N.en['provider.noModelSelected'], /Select a model from the chat picker/);
  assert.ok(pkg.contributes.configuration.properties['cude-ai.providers']);
  assert.ok(pkg.contributes.configuration.properties['cude-ai.activeProviderId']);
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, true);
  for (const provider of ['openai-compatible','openai','anthropic','gemini','azure','nvidia','openrouter','ollama']) assert.ok(pkg.contributes.configuration.properties['cude-ai.provider'].enum.includes(provider));
});

test('0c composer exposes queued chat controls, attachments, memory, and active context',()=>{
  const panelScript=prepareWebviewScript(chat,/<script nonce="\{\{NONCE\}\}">([\s\S]*?)<\/script>/);
  assert.ok(panelScript);assert.doesNotThrow(()=>new vm.Script(panelScript));
  for(const token of ['queuedMessages',"t('status.queueCount')",'event.key===\'Escape\'','event.key===\'Tab\'','value: \'plan\'','lastSent','event.key===\'ArrowUp\'','event.clipboardData','dataTransfer','# Hafızaya not ekle','context-ring','activeContext','includeActive'])assert.ok(chat.includes(token),token);
  for(const command of ['/plan','/agent','/clear','/compact','/model','/review','/init','/memory','/mcp'])assert.ok(chat.includes(`name: '${command}'`),command);
  assert.match(source,/onDidChangeTextEditorSelection/);assert.match(source,/message\.type==='memoryNote'/);
  assert.match(source,/message\.includeActive===false/);
});

test('review, spec, agent, memory and MCP workflows are contributed', () => {
  for (const id of ['editSelection','spec','runSpecTask','agent','agentManager','memory','saveMemory','mcp','mcpCall','about']) assert.ok(pkg.contributes.commands.some(c=>c.command===`cude-ai.${id}`), id);
  assert.ok(pkg.contributes.menus['view/title'].some(item=>item.command==='cude-ai.newAgentWorktree'));
  assert.match(pkg.contributes.viewsWelcome.find(view=>view.view==='cude-ai.agents').contents,/New isolated worktree/);
  assert.ok(pkg.contributes.commands.some(command=>command.command==='cude-ai.toggleAgentsLayout'));
  assert.ok(pkg.contributes.keybindings.some(binding=>binding.command==='cude-ai.toggleAgentsLayout'&&binding.key==='ctrl+alt+a'));
  const managerScript=prepareWebviewScript(agentsHtml,/<script nonce="__NONCE__">([\s\S]*?)<\/script>/);assert.ok(managerScript);assert.doesNotThrow(()=>new vm.Script(managerScript));
  for(const token of ['Editor','Agents','startAgent','reviewFile','previewFile','mergeWorktree','worktree','permission','providerId','aria-pressed'])assert.ok(agentsHtml.includes(token),token);
  assert.match(agentsHtml,/\[hidden\]\{display:none!important\}/);
  for (const capability of ['vscode.diff','.cude','memory.md','mcp.json','applyEdit','Version 0.1.0']) assert.ok(source.includes(capability), capability);
});

test('inline pending-change cards speak acceptChange/rejectChange and support per-file decisions',()=>{
  const click=chat.match(/column\.addEventListener\('click',[\s\S]*?window\.addEventListener\('message'/)?.[0]||'';
  assert.match(click,/data-pending-action/);assert.match(chat,/acceptChange/);assert.match(chat,/rejectChange/);
  assert.match(chat,/data\.type==='pendingChange'/);assert.match(chat,/data\.files/);assert.match(chat,/chat\.acceptAll/);assert.match(chat,/chat\.rejectAll/);
  assert.doesNotMatch(chat,/type:'acceptProposal'|type:'rejectProposal/);
});

test('Cude owns the startup AI surface and safe project cloning flow', () => {
  assert.ok(pkg.contributes.commands.some(command => command.command === 'cude-ai.chat'));
  assert.ok(pkg.contributes.iconThemes.some(theme => theme.id === 'cude-icons'));
  assert.ok(pkg.contributes.commands.some(command => command.command === 'cude-ai.cloneAndOwn'));
  assert.match(source, /registerWebviewViewProvider\('cude-ai\.chatView'/);
  assert.match(chat, /Work on your project/);
  assert.ok(pkg.activationEvents.includes('onStartupFinished'));
  assert.ok(pkg.activationEvents.includes('onView:cude-ai.chatView'));
  assert.ok(pkg.contributes.viewsWelcome.some(view=>view.view==='cude-ai.chatView'));
  assert.match(source, /--no-recurse-submodules/);
  assert.match(source, /GIT_TERMINAL_PROMPT:'0'/);
  assert.match(source, /Do not assist with cheats, malware, credential theft, evasion, or unauthorized access/);
});
test('Cude starts in its restrained branded conversation surface', () => {
  const build = fs.readFileSync(path.join(root, '..', '..', 'build', 'build.ps1'), 'utf8');
  const finalize = fs.readFileSync(path.join(root, '..', '..', 'build', 'finalize.ps1'), 'utf8');
  const runtime = fs.readFileSync(path.join(root, '..', '..', 'build', 'patch-runtime.ps1'), 'utf8');
  const defaultAgent = JSON.parse(fs.readFileSync(path.join(root, '..', '..', 'build', 'default-chat-agent.json'), 'utf8'));
  assert.ok(Object.keys(defaultAgent).length >= 30, 'preserve the complete defaultChatAgent contract');
  assert.equal(defaultAgent.provider.default.id, 'cude');
  assert.ok(defaultAgent.provider.enterprise.id);
  assert.equal(defaultAgent.providerExtensionId, '', 'do not trigger GitHub authentication from the startup default agent');
  assert.match(runtime, /github-authentication/);
  assert.match(runtime, /contributes\.authentication=@\(\)/);
  assert.match(runtime, /async _getGitHubToken\(\)\{return\}/);
  assert.match(runtime, /async _refreshGitHubSession\(\)\{\}/);
  assert.match(runtime, /extensionEnabledApiProposals\.PSObject\.Properties\.Remove/);
  assert.match(chat, /--vscode-sideBar-background/);
  assert.match(chat, /--accent: #d69b70;/); assert.doesNotMatch(chat, /--vscode-focusBorder/);
  assert.match(chat, /t\('chat\.addProviderFirst'\)/);
  assert.match(chat, /data-i18n-title="chat\.history" data-i18n="chat\.new">New chat/);
  assert.match(chat, /{{LOGO}}/);
  assert.match(chat, /name: '\/agent'/);
  assert.match(chat, /name: '\/plan'/);
  assert.match(chat, /value: 'full'/);
  assert.match(chat, /value: 'auto'/);
  assert.match(chat, /shortcuts/);
  assert.match(chat, /@/);
  assert.match(chat, /\/plan/);
  assert.match(chat, /data-copy/);
  assert.match(chat, /activity-content/);
  assert.match(chat, /className = 'changes'/);
  assert.doesNotMatch(chat, /Build with intent|What are we building\?|drop-shadow|Thinking…/);
  assert.match(source, /onDelta/);
  assert.ok(pkg.contributes.viewsContainers.secondarySidebar.some(container=>container.id==='cude-ai-chat'));
  assert.match(source, /!chatView\.hasSidebar\(\)&&!hasUpdatesPanel\(\)/);
  assert.match(source, /findProjectFiles/);
  assert.match(source, /grepProject/);
  assert.match(source, /find_files/);
  assert.match(source, /cude-core\.grep/);
  assert.match(source, /request\('tools\/call'/);
  assert.match(source, /mcp-protocol-version/i);
  assert.match(source, /Review its arguments and side effects first/);
  assert.doesNotMatch(source, /core\.call\('index'/);
  assert.doesNotMatch(JSON.stringify(pkg.configurationDefaults), /workbench\.enableExperiments/);
  assert.equal(pkg.configurationDefaults['workbench.sideBar.location'],'left');
  assert.equal(pkg.configurationDefaults['workbench.secondarySideBar.defaultVisibility'],'visible');
  assert.equal(pkg.configurationDefaults['workbench.startupEditor'],undefined);
  assert.equal(pkg.configurationDefaults['workbench.layoutControl.enabled'],undefined);
  assert.equal(pkg.configurationDefaults['editor.accessibilitySupport'],undefined);
  assert.equal(pkg.configurationDefaults['window.restoreWindows'],undefined);
  assert.equal(pkg.configurationDefaults['window.menuBarVisibility'],'hidden');
  assert.equal(pkg.configurationDefaults['window.titleBarStyle'],'custom');
  assert.equal(pkg.contributes.menus['viewContainer/title'], undefined);
  assert.ok(pkg.contributes.menus['view/title'].some(item=>item.command==='cude-ai.chat'));
  assert.ok(pkg.contributes.menus['view/title'].some(item=>item.command==='cude-ai.agentManager'));
  assert.doesNotMatch(source, /workbench\.action\.increaseViewSize/);
  assert.match(chat,/providerModels/);
  assert.match(chat,/class="tool-menu-button"/);
  for (const script of [build, finalize]) {
    // layoutControl artık çekirdek yaması (patch-runtime.ps1) ile kapatılıyor; finalize ayar yazmıyor.
    if (script === build) assert.match(script, /workbench\.layoutControl\.enabled'=\$false/);
    assert.match(script, /resources\\app\\resources\\win32/);
    assert.match(script, /vscode-icon\.svg/);
    assert.match(script, /code_150x150\.png/);
    // Bu varsayılanlar build.ps1 ayarlarında + patch-runtime.ps1 çekirdek yamasında; finalize ayar dosyası yazmaz.
    if (script === build) assert.match(script, /window\.restoreWindows'='one'/);
    if (script === build) assert.match(script, /editor\.accessibilitySupport'='off'/);
    assert.match(script, /darwinBundleIdentifier='com\.cudeide'/);
  }
});

test('AI panel polish fixes escaped code, menus, activity hierarchy, and plan labels', () => {
  const panelScript = prepareWebviewScript(chat,/<script nonce="\{\{NONCE\}\}">([\s\S]*?)<\/script>/);
  assert.ok(panelScript, 'Cude chat panel script is present');
  assert.doesNotThrow(() => new vm.Script(panelScript), 'the webview script parses as JavaScript');
  assert.match(chat, /let value = source\.replace\(\/```/);
  assert.match(chat, /value = escapeHtml\(value\);[\s\S]*?highlight\(block\.code, block\.language\)/);
  assert.match(chat, /javascript: 'const let var function/);
  assert.match(chat, /python: 'def class return/);
  assert.match(chat, /rust: 'fn pub use/);
  assert.match(chat, /json: 'true false null/);
  assert.match(chat, /bash: 'if then else/);
  assert.match(chat, /lang === 'diff' \|\| lang === 'patch'/);
  assert.match(chat, /--syntax-keyword:/);
  assert.doesNotMatch(chat, /<select\b/i);
  assert.match(chat, /id="permission-toggle"/);
  assert.match(chat, /id="model-toggle"/);
  assert.match(chat, /id="effort-toggle"/);
  assert.match(chat, /function renderPermissionMenu\(\)[\s\S]*?permission = item\.value; renderPermissionMenu\(\)/);
  assert.match(chat, /function renderEffortMenu\(\)[\s\S]*?effort = item\.value; renderEffortMenu\(\)/);
  assert.match(chat, /if \(!selectedModel\) \{ setStatus\(modelOptions\.length \? t\('chat\.chooseModelFirst'\) : t\('chat\.addProviderFirst'\)\); openModelFromTop\(\); return; \}/);
  assert.match(chat, /\.composer textarea:focus-visible \{ outline: 0; \}/);
  assert.doesNotMatch(chat, /Yanıtlar ve dosya değişiklikleri gözden geçirilir/);
  assert.match(chat, /data-i18n-title="chat\.history" data-i18n="chat\.new">New chat/);
  assert.doesNotMatch(chat, /\.top \{[^}]*border-bottom/);
  assert.match(chat, /activity-icon/);
  assert.match(chat, /activity\.running summary > \.activity-label/);
  assert.match(chat, /activity\.done/);
  assert.match(chat, /flex: 0 0 auto; white-space: nowrap; padding: 2px 7px/);
  assert.ok(chat.includes("t('agent.changes') : step.kind === 'command' ? 'Command' : step.kind === 'mcp' ? ('MCP · ' + String(step.tool || '').slice(0, 40)) : t('chat.plan')"));
  const highlightStart = chat.indexOf('    function highlight(');
  const renderStart = chat.indexOf('    function renderMarkdown(', highlightStart);
  const renderEnd = chat.indexOf('    function iconMarkup(', renderStart);
  assert.ok(highlightStart >= 0 && renderStart > highlightStart && renderEnd > renderStart);
  const renderFunctions = chat.slice(highlightStart, renderEnd);
  const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const renderedTs = vm.runInNewContext(`${renderFunctions}\nrenderMarkdown(${JSON.stringify('```ts\nconst message = "Hello & Cude";\n```')})`, { escapeHtml });
  assert.match(renderedTs, /tok-keyword">const<\/span>/);
  assert.match(renderedTs, /tok-string">&quot;Hello &amp; Cude&quot;<\/span>/);
  assert.doesNotMatch(renderedTs, /&amp;quot;/, 'code text must be escaped once, not displayed as an entity');
  const renderedJson = vm.runInNewContext(`${renderFunctions}\nrenderMarkdown(${JSON.stringify('```json\n{"name": "Cude", "enabled": true}\n```')})`, { escapeHtml });
  assert.match(renderedJson, /tok-property">&quot;name&quot;<\/span>/);
  const renderedDiff = vm.runInNewContext(`${renderFunctions}\nrenderMarkdown(${JSON.stringify('```diff\n+added\n-removed\n```')})`, { escapeHtml });
  assert.match(renderedDiff, /tok-added">\+added/);
  assert.match(renderedDiff, /tok-removed">-removed/);
});


