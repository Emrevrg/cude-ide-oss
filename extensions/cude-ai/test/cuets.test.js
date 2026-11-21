const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parsePlan, parsePlanDetailed, parseWorkerOutput, autoCuetsDecision, shouldAutoCuets, mapLimit, mergeWorkerSteps, runCuets } = require(path.join(__dirname, '..', 'out', 'cuets.js'));
const { t } = require(path.join(__dirname, '..', 'out', 'i18n.js'));

const TASK = 'Add login and signup pages';

test('plan parser reads valid JSON and caps subtasks at four', () => {
  const plan = parsePlan(JSON.stringify({ subtasks: [
    { title: 'API', instruction: 'Add auth endpoints' },
    { title: 'UI', instruction: 'Add login form' },
    { title: 'Tests', instruction: 'Cover auth flows' },
    { title: 'Docs', instruction: 'Document auth' },
    { title: 'Extra', instruction: 'Must be dropped' },
  ] }), TASK);
  assert.equal(plan.length, 4);
  assert.deepEqual(plan[0], { title: 'API', instruction: 'Add auth endpoints' });
  assert.equal(plan.at(-1).title, 'Docs');
});

test('plan parser accepts ```json fenced output with surrounding prose and alternate keys', () => {
  const reply = 'Here is the plan:\n```json\n{"tasks":[{"name":"Backend","task":"Add routes"},{"title":"Frontend","description":"Add pages"},{"title":"Backend","instruction":"duplicate"}]}\n```\nDone.';
  const { subtasks, fallback } = parsePlanDetailed(reply, TASK);
  assert.equal(fallback, false);
  assert.deepEqual(subtasks, [{ title: 'Backend', instruction: 'Add routes' }, { title: 'Frontend', instruction: 'Add pages' }]);
  assert.equal(parsePlan('[{"title":"Only","instruction":"one"}]', TASK).length, 1, 'bare arrays are accepted');
});

test('plan parser falls back to a single subtask on garbage', () => {
  for (const garbage of ['not json at all', '```json\n{broken\n```', '{"subtasks": "nope"}', '', '{"subtasks":[{"foo":1}]}']) {
    const { subtasks, fallback } = parsePlanDetailed(garbage, TASK);
    assert.equal(fallback, true, `fallback for ${JSON.stringify(garbage)}`);
    assert.deepEqual(subtasks, [{ title: TASK, instruction: TASK }]);
  }
});

test('worker output uses the agent JSON shape and drops unsafe/incomplete steps', () => {
  const parsed = parseWorkerOutput('```json\n{"summary":"ok","steps":[{"title":"Edit","kind":"file","path":"src/a.ts","content":"x"},{"title":"No content","kind":"file","path":"src/b.ts"},{"title":"Run","kind":"command","command":"npm test"},{"title":"Bad","kind":"delete"}]}\n```');
  assert.equal(parsed.summary, 'ok');
  assert.deepEqual(parsed.steps.map(step => step.kind), ['file', 'command']);
  assert.deepEqual(parseWorkerOutput('plain prose answer'), { summary: 'plain prose answer', steps: [] });
  const merged = mergeWorkerSteps([
    { index: 0, status: 'done', steps: [{ title: 'A', kind: 'file', path: 'src/a.ts', content: '1' }] },
    { index: 1, status: 'done', steps: [{ title: 'B', kind: 'file', path: './src/a.ts', content: '2' }, { title: 'C', kind: 'analysis' }] },
    { index: 2, status: 'failed', steps: [{ title: 'D', kind: 'file', path: 'x.ts', content: '' }] },
  ]);
  assert.deepEqual(merged.steps.map(step => step.title), ['A', 'C']);
  assert.deepEqual(merged.conflicts, ['./src/a.ts']);
});

test('auto-switch heuristic detects multi-step tasks in English and Turkish', () => {
  const multi = [
    'Implement a todo app with a REST API, a React frontend and persistence, and then add tests for it.',
    'Refactor the whole project to use dependency injection.',
    'Please do the following:\n- add a settings page\n- store preferences\n- add a dark mode toggle',
    'Update src/a.ts, src/b.ts and src/c.ts to use the new logger.',
    'Bu çok adımlı bir iş: kimlik doğrulama ekle.',
    'Önce veritabanı şemasını oluştur, ardından API uçlarını yaz, sonra da arayüzü bağla.',
    'Kullanıcı yönetimi için uçtan uca bir modül geliştir ve testlerini yaz, ayrıca belgelerini güncelle.',
    'x'.repeat(950),
  ];
  for (const text of multi) assert.equal(shouldAutoCuets(text), true, text.slice(0, 60));
  const single = [
    'What does this function do?',
    'Why does the build fail?',
    'Rename foo to bar.',
    'Bu fonksiyon ne işe yarıyor?',
    'Neden derleme başarısız oluyor, nasıl düzeltirim?',
    '',
    'Fix the typo in README.',
  ];
  for (const text of single) assert.equal(shouldAutoCuets(text), false, text);
  const decision = autoCuetsDecision('Refactor the whole project to use dependency injection.');
  assert.equal(decision.reason, 'cuets.reason.explicit');
  assert.ok(t(decision.reason, 'en').length && t(decision.reason, 'tr') !== t(decision.reason, 'en'), 'reason is localized');
});

test('concurrency limiter keeps order, caps parallelism and honours abort', async () => {
  let active = 0, peak = 0;
  const results = await mapLimit([30, 10, 20, 5, 15], 2, async (ms, index) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, ms));
    active--; return index * 10;
  });
  assert.deepEqual(results, [0, 10, 20, 30, 40]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([], 2, async () => 1), []);

  const controller = new AbortController();
  let started = 0;
  await assert.rejects(mapLimit([1, 2, 3, 4], 2, async () => { started++; if (started === 2) controller.abort(); await new Promise(r => setTimeout(r, 5)); }, controller.signal), error => error.name === 'AbortError');
  assert.equal(started, 2, 'no new work starts after abort');
});

test('runCuets plans, runs workers with a limit of two, reviews and streams the final answer', async () => {
  const activities = [], deltas = [];
  let active = 0, peak = 0;
  const chat = async (messages, signal, onDelta) => {
    const system = messages[0].content;
    if (system.includes('Cuets planner')) return '```json\n{"subtasks":[{"title":"API","instruction":"a"},{"title":"UI","instruction":"b"},{"title":"Tests","instruction":"c"}]}\n```';
    if (system.includes('Cuets worker')) {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 15));
      active--;
      if (messages[1].content.includes('Your subtask (2)')) throw new Error('model offline');
      return JSON.stringify({ summary: 'done', steps: [{ title: 'Edit', kind: 'file', path: 'src/x.ts', content: 'y' }] });
    }
    assert.match(messages[1].content, /Agent 2: UI \(failed\)/);
    for (const part of ['Final ', 'answer']) onDelta?.(part);
    return 'Final answer';
  };
  const result = await runCuets({ task: TASK, chat, context: async () => 'ctx', label: (key, values) => t(key, 'en', values), onActivity: (label) => activities.push(label), onDelta: delta => deltas.push(delta) });
  assert.equal(peak, 2);
  assert.equal(result.plan.length, 3);
  assert.deepEqual(result.workers.map(worker => worker.status), ['done', 'failed', 'done']);
  assert.equal(result.steps.length, 1, 'duplicate file proposal merged');
  assert.deepEqual(result.conflicts, ['src/x.ts']);
  assert.match(result.answer, /^Final answer/);
  assert.deepEqual(deltas, ['Final ', 'answer']);
  assert.equal(activities[0], 'Planning');
  assert.ok(activities.includes('Agent 1: API') && activities.includes('Agent 2: UI') && activities.includes('Agent 2 failed · UI'));
  assert.equal(activities.filter(label => label === 'Reviewing').length, 1);
  assert.ok(!activities.some(label => /[ğışçöü]/i.test(label)), 'no Turkish text in English mode');
});

test('runCuets surfaces total failure and cancellation clearly', async () => {
  const label = (key, values) => t(key, 'en', values);
  const failing = async messages => { if (messages[0].content.includes('planner')) return 'garbage'; throw new Error('quota exceeded'); };
  await assert.rejects(runCuets({ task: TASK, chat: failing, context: async () => '', label }), /All Cuets agents failed\. First error: quota exceeded/);

  const controller = new AbortController();
  const slow = async (messages, signal) => { controller.abort(); throw new Error('Provider request timed out or was cancelled.'); };
  await assert.rejects(runCuets({ task: TASK, chat: slow, context: async () => '', label, signal: controller.signal }), error => error.name === 'AbortError');
});

// ---------------- Long-running Cuets ----------------
const cuets = require(path.join(__dirname, '..', 'out', 'cuets.js'));
const enLabel = (key, values) => t(key, 'en', values);
const PLAN = [{ title: 'API', instruction: 'Add routes' }, { title: 'UI', instruction: 'Add pages' }];
const freshState = (overrides = {}) => Object.assign(cuets.createTaskState(TASK, PLAN, { id: 'abcd-1234', now: 1000, maxRounds: 8, budgetMs: 30 * 60_000 }), overrides);
const passed = { command: 'npm test', ok: true, exitCode: 0, output: 'ok', durationMs: 5, at: 1 };
const failedCheck = { command: 'npm test', ok: false, exitCode: 1, output: '1 failing', durationMs: 5, at: 1 };

test('stop rule: all items done + verification passed completes; unverified only when no checks exist', () => {
  const state = freshState();
  state.checklist.forEach(item => { item.status = 'done'; });
  assert.equal(cuets.evaluateStop(state, { verificationAvailable: true }), undefined, 'checks available but not run yet: keep going');
  state.lastVerification = failedCheck;
  assert.equal(cuets.evaluateStop(state, { verificationAvailable: true }), undefined, 'failing checks never count as done');
  state.lastVerification = passed;
  assert.equal(cuets.evaluateStop(state, { verificationAvailable: true }), 'complete');
  state.lastVerification = undefined;
  assert.equal(cuets.evaluateStop(state, { verificationAvailable: false }), 'completeUnverified');
  state.lastVerification = { ...failedCheck, skipped: true };
  assert.equal(cuets.evaluateStop(state, { verificationAvailable: true }), 'completeUnverified');
  assert.equal(cuets.evaluateStop(freshState(), { verificationAvailable: true }), undefined, 'pending work continues');
  assert.equal(cuets.evaluateStop(state, { verificationAvailable: true, aborted: true }), 'cancelled', 'cancel wins');
});

test('stop rule: two rounds without progress, round limit, blocked items', () => {
  assert.equal(cuets.evaluateStop(freshState({ noProgressRounds: 1 }), { verificationAvailable: true }), undefined);
  assert.equal(cuets.evaluateStop(freshState({ noProgressRounds: 2 }), { verificationAvailable: true }), 'noProgress');
  assert.equal(cuets.evaluateStop(freshState({ round: 8 }), { verificationAvailable: true }), 'maxRounds');
  const blocked = freshState(); blocked.checklist.forEach(item => { item.status = 'failed'; item.attempts = cuets.CUETS_MAX_ATTEMPTS; });
  assert.equal(cuets.evaluateStop(blocked, { verificationAvailable: true }), 'blocked');
  assert.equal(cuets.madeProgress(0, 1), true, 'an item finished');
  assert.equal(cuets.madeProgress(1, 1, failedCheck, passed), true, 'checks newly pass');
  assert.equal(cuets.madeProgress(1, 1, failedCheck, failedCheck), false);
  assert.equal(cuets.madeProgress(1, 1, passed, passed), false, 'still passing is not new progress');
  assert.equal(cuets.madeProgress(1, 1, undefined, { ...passed, skipped: true }), false);
});

test('stop rule: wall-clock budget', () => {
  assert.equal(cuets.evaluateStop(freshState({ elapsedMs: 30 * 60_000 }), { verificationAvailable: true }), 'budget');
  assert.equal(cuets.evaluateStop(freshState({ elapsedMs: 30 * 60_000 - 1 }), { verificationAvailable: true }), undefined);
  assert.equal(cuets.evaluateStop(freshState({ elapsedMs: 31 * 60_000, round: 99, noProgressRounds: 5 }), { verificationAvailable: true }), 'budget', 'budget reported before rounds/no-progress');
});

test('test command detection for node, rust, python and go', () => {
  const pkg = scripts => JSON.stringify({ scripts });
  assert.deepEqual(cuets.detectVerificationCommands(['package.json', 'src'], { 'package.json': pkg({ compile: 'tsc -p .', test: 'node --test' }) }).map(c => c.command), ['npm run compile', 'npm test']);
  assert.deepEqual(cuets.detectVerificationCommands(['package.json', 'pnpm-lock.yaml'], { 'package.json': pkg({ build: 'vite build', test: 'vitest run' }) }).map(c => c.command), ['pnpm run build', 'pnpm run test']);
  assert.deepEqual(cuets.detectVerificationCommands(['package.json', 'yarn.lock'], { 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .' }) }).map(c => c.command), ['yarn lint'], 'npm placeholder test is ignored, lint is the fallback');
  assert.deepEqual(cuets.detectVerificationCommands(['package.json'], { 'package.json': '{broken' }), [], 'malformed package.json yields nothing');
  assert.deepEqual(cuets.detectVerificationCommands(['Cargo.toml', 'src'], {}).map(c => c.command), ['cargo test']);
  assert.deepEqual(cuets.detectVerificationCommands(['pyproject.toml'], { 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"' }).map(c => c.command), ['python -m pytest -q']);
  assert.deepEqual(cuets.detectVerificationCommands(['requirements.txt', 'tests'], {}).map(c => c.command), ['python -m pytest -q']);
  assert.deepEqual(cuets.detectVerificationCommands(['setup.py'], {}), [], 'python without tests: nothing to run');
  assert.deepEqual(cuets.detectVerificationCommands(['go.mod'], {}).map(c => c.command), ['go test ./...']);
  assert.deepEqual(cuets.detectVerificationCommands(['README.md'], {}), []);
  const node = cuets.detectVerificationCommands(['package.json'], { 'package.json': pkg({ test: 'jest' }) })[0];
  assert.match(node.fingerprint, /jest/, 'fingerprint changes when the script body changes');
});

test('reviewer checklist parsing is robust: fenced JSON updates, garbage keeps the previous state', () => {
  const previous = freshState().checklist;
  const reply = 'Sure.\n```json\n{"summary":"API done","items":[{"id":1,"status":"completed","note":"routes added"},{"id":"2","status":"needs work"},{"id":"99","status":"done"}],"add":[{"title":"Tests","instruction":"Cover routes"},{"title":"API","instruction":"dup"}]}\n```';
  const update = cuets.parseChecklistUpdate(reply, previous);
  assert.equal(update.parsed, true);
  assert.equal(update.summary, 'API done');
  assert.deepEqual(update.checklist.map(item => [item.id, item.title, item.status]), [['1', 'API', 'done'], ['2', 'UI', 'pending'], ['3', 'Tests', 'pending']]);
  assert.equal(update.checklist[0].note, 'routes added');
  assert.equal(previous[0].status, 'pending', 'input checklist is not mutated');
  for (const garbage of ['not json', '```json\n{"items": [oops\n```', '{"items":"nope"}', '{"items":[{"id":"42","status":"done"}]}', '{"items":[{"id":"1","status":"banana"}]}', '[]', '', 'null']) {
    const result = cuets.parseChecklistUpdate(garbage, previous);
    assert.equal(result.parsed, false, `garbage: ${JSON.stringify(garbage)}`);
    assert.deepEqual(result.checklist, previous);
  }
  const many = cuets.parseChecklistUpdate(JSON.stringify({ add: Array.from({ length: 8 }, (_, i) => ({ title: `Extra ${i}` })) }), previous);
  assert.equal(many.checklist.length, previous.length + 3, 'at most three new items per review');
});

test('task state serializes, redacts secrets, validates on load and resumes', () => {
  const state = freshState({ round: 3, elapsedMs: 1234.6, noProgressRounds: 1, status: 'stopped', stopReason: 'maxRounds' });
  state.notes.push('used key sk-abcdefghijklmnopqrstuvwx and password=hunter22');
  state.lastVerification = { ...failedCheck, output: 'Authorization: Bearer abcdefghijklmnop12345\n' + 'x'.repeat(20000) };
  state.checklist[0].status = 'in_progress';
  const text = cuets.serializeTaskState(state);
  assert.doesNotMatch(text, /sk-abcdefghijklmnopqrstuvwx|hunter22|abcdefghijklmnop12345/);
  const loaded = cuets.parseTaskState(text);
  assert.equal(loaded.id, 'abcd-1234'); assert.equal(loaded.round, 3); assert.equal(loaded.stopReason, 'maxRounds');
  assert.ok(loaded.lastVerification.output.length <= cuets.CUETS_VERIFY_OUTPUT_MAX + 100, 'verification output is bounded');
  for (const bad of ['', '{', '{"version":2}', JSON.stringify({ version: 1, id: '../evil', goal: 'x', checklist: [] })]) assert.equal(cuets.parseTaskState(bad), undefined);
  assert.equal(cuets.isResumable(loaded), true);
  assert.equal(cuets.isResumable({ ...loaded, status: 'done', stopReason: 'complete' }), false);
  assert.equal(cuets.isResumable({ ...loaded, status: 'discarded' }), false);
  const resumed = cuets.resumeTaskState(loaded, { maxRounds: 8, budgetMs: 30 * 60_000, now: 5000 });
  assert.equal(resumed.maxRounds, 11, 'resume grants a fresh round allowance'); assert.equal(resumed.status, 'running'); assert.equal(resumed.stopReason, undefined);
  assert.equal(resumed.checklist[0].status, 'pending', 'interrupted items go back to pending'); assert.equal(resumed.noProgressRounds, 0);
  const md = cuets.taskMarkdown(loaded, enLabel);
  assert.match(md, /^# Add login and signup pages/); assert.match(md, /Round 3\/8/); assert.doesNotMatch(md, /hunter22/);
  assert.equal(cuets.isValidTaskId(cuets.newTaskId(Date.now(), 'a1b2c3')), true);
  for (const word of ['continue', 'Continue.', 'devam', 'devam et', 'resume']) assert.equal(cuets.isContinueCommand(word), true, word);
  for (const word of ['continue with the login page refactor', 'devam eden işleri listele', '']) assert.equal(cuets.isContinueCommand(word), false, word);
});

function loopChat({ reviewer }) {
  let round = 0;
  return async messages => {
    const system = messages[0].content;
    if (system.includes('Cuets planner')) return JSON.stringify({ subtasks: PLAN });
    if (system.includes('ONE checklist item')) return JSON.stringify({ summary: 'did it', steps: [{ title: 'Edit', kind: 'file', path: `src/${messages[1].content.match(/Your item \((\d+)\)/)[1]}.ts`, content: 'x' }] });
    if (system.includes('Cuets reviewer for a long-running')) return reviewer(messages[1].content, ++round);
    throw new Error('unexpected prompt');
  };
}

test('runCuetsLoop keeps working across rounds until items are done and checks pass', async () => {
  const saves = [], applied = [], phases = [];
  let checks = 0;
  const result = await cuets.runCuetsLoop({
    goal: TASK, id: 'abcd-1234', mode: 'execute', label: enLabel, verificationAvailable: true, maxRounds: 8, budgetMs: 30 * 60_000,
    chat: loopChat({ reviewer: (content) => {
      const worked = content.match(/Worked on this round: ([\d, ]+)/)[1].split(',').map(s => s.trim());
      return '```json\n' + JSON.stringify({ summary: 'progress', items: worked.map(id => ({ id, status: 'done' })) }) + '\n```';
    } }),
    context: async () => 'ctx',
    applySteps: async steps => { applied.push(steps.map(step => step.path)); return { applied: steps.length, failed: [] }; },
    verify: async () => (++checks === 1 ? failedCheck : passed),
    save: async state => { saves.push(JSON.parse(cuets.serializeTaskState(state))); },
    onProgress: (_state, phase) => phases.push(phase),
  });
  assert.equal(result.stopReason, 'complete');
  assert.equal(result.state.status, 'done');
  assert.equal(result.state.round, 2, 'round 1 did both items, round 2 fixed the failing checks');
  assert.deepEqual(applied, [['src/1.ts', 'src/2.ts'], ['src/3.ts']]);
  assert.equal(result.state.checklist.at(-1).kind, 'fix');
  assert.equal(checks, 2);
  assert.ok(saves.length >= 4 && saves.every(saved => saved.id === 'abcd-1234'));
  assert.ok(phases.includes('verifying') && phases.at(-1) === 'stopped');
  assert.match(result.summary, /Done: every checklist item is complete and the project checks passed/);
  assert.match(result.summary, /Round 2\/8/);
});

test('runCuetsLoop stops after two rounds without progress and keeps the checklist when the reviewer returns garbage', async () => {
  const result = await cuets.runCuetsLoop({
    goal: TASK, id: 'abcd-1234', mode: 'execute', label: enLabel, verificationAvailable: false,
    chat: loopChat({ reviewer: () => 'I could not decide, sorry.' }), context: async () => '',
    applySteps: async () => ({ applied: 0, failed: [] }), save: async () => {},
  });
  assert.equal(result.stopReason, 'noProgress');
  assert.equal(result.state.round, 2);
  assert.deepEqual(result.state.checklist.map(item => item.status), ['pending', 'pending']);
  assert.ok(result.state.notes.some(note => /previous checklist was kept/.test(note)));
  assert.match(result.summary, /two rounds in a row made no progress/);
});

test('runCuetsLoop honours the wall-clock budget, cancellation and plan-only mode', async () => {
  let clock = 0;
  const budget = await cuets.runCuetsLoop({
    goal: TASK, id: 'abcd-1234', mode: 'execute', label: enLabel, verificationAvailable: false, budgetMs: 60_000, now: () => (clock += 20_000),
    chat: loopChat({ reviewer: (content, round) => JSON.stringify({ items: [{ id: String(round), status: 'done' }] }) }), context: async () => '', concurrency: 1,
    applySteps: async () => ({ applied: 1, failed: [] }), save: async () => {},
  });
  assert.equal(budget.stopReason, 'budget');
  assert.ok(budget.state.elapsedMs >= 60_000);

  const controller = new AbortController();
  const cancelled = await cuets.runCuetsLoop({
    goal: TASK, id: 'abcd-1234', mode: 'execute', label: enLabel, verificationAvailable: false, signal: controller.signal,
    chat: loopChat({ reviewer: () => '{}' }), context: async () => '',
    applySteps: async () => { controller.abort(); return { applied: 0, failed: [], stop: true }; }, save: async () => {},
  });
  assert.equal(cancelled.stopReason, 'cancelled');
  assert.equal(cancelled.state.status, 'stopped');
  assert.ok(cancelled.state.checklist.every(item => item.status !== 'in_progress'), 'resumable: nothing left in progress');

  let applyCalls = 0;
  const planned = await cuets.runCuetsLoop({
    goal: TASK, id: 'abcd-1234', mode: 'plan', label: enLabel, verificationAvailable: false,
    chat: loopChat({ reviewer: () => '{}' }), context: async () => '',
    applySteps: async () => { applyCalls++; return { applied: 0, failed: [] }; }, save: async () => {},
  });
  assert.equal(planned.stopReason, 'planOnly');
  assert.equal(planned.state.status, 'paused');
  assert.equal(applyCalls, 0, 'plan mode never applies');
  assert.equal(planned.lastSteps.length, 2, 'proposals are returned for the plan card');
});
