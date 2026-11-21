// Cuets: planner -> parallel workers -> reviewer pipeline.
// This module is intentionally free of `vscode` imports so it can be unit-tested with plain Node.
import type { MessageKey } from './i18n';

export type CuetsSubtask = { title: string; instruction: string };
export type CuetsStep = { title: string; kind: 'file' | 'command' | 'analysis'; path?: string; content?: string; command?: string };
export type CuetsWorkerResult = { index: number; title: string; instruction: string; status: 'done' | 'failed'; summary: string; steps: CuetsStep[]; output: string };
export type CuetsMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type CuetsChat = (messages: CuetsMessage[], signal?: AbortSignal, onDelta?: (delta: string) => void) => Promise<string>;
export type CuetsLabel = (key: MessageKey, values?: Record<string, string | number>) => string;
export type CuetsOptions = {
  task: string;
  chat: CuetsChat;
  /** Project context for the planner (subtask undefined) or for one worker. */
  context: (subtask?: CuetsSubtask) => Promise<string>;
  label: CuetsLabel;
  onActivity?: (label: string, detail: string) => void;
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
  concurrency?: number;
};
export type CuetsResult = { plan: CuetsSubtask[]; planFallback: boolean; workers: CuetsWorkerResult[]; steps: CuetsStep[]; conflicts: string[]; answer: string };

export const CUETS_MAX_SUBTASKS = 4;
export const CUETS_CONCURRENCY = 2;

export function abortError(message = 'Cuets request was cancelled.'): Error {
  const error = new Error(message); error.name = 'AbortError'; return error;
}

/** Extracts the first parseable JSON value from model output (raw, ```json fenced, or embedded in prose). */
export function extractJson(text: string): unknown {
  const value = String(text ?? '').trim();
  if (!value) return undefined;
  const candidates: string[] = [value];
  for (const match of value.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)) candidates.push(match[1].trim());
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = value.indexOf(open), end = value.lastIndexOf(close);
    if (start >= 0 && end > start) candidates.push(value.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* try next candidate */ }
  }
  return undefined;
}

function fallbackTitle(task: string): string {
  const line = task.trim().split(/\r?\n/)[0] || 'Task';
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

/** Parses a planner reply into 1-4 subtasks. Falls back to a single subtask containing the whole task. */
export function parsePlanDetailed(text: string, task: string): { subtasks: CuetsSubtask[]; fallback: boolean } {
  const parsed: any = extractJson(text);
  const list: unknown = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? (parsed.subtasks ?? parsed.tasks ?? parsed.plan ?? parsed.steps) : undefined;
  const seen = new Set<string>(), subtasks: CuetsSubtask[] = [];
  if (Array.isArray(list)) {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const raw = item as Record<string, unknown>;
      const pick = (...keys: string[]) => { for (const key of keys) if (typeof raw[key] === 'string' && (raw[key] as string).trim()) return (raw[key] as string).trim(); return ''; };
      const title = pick('title', 'name', 'summary').slice(0, 80);
      const instruction = (pick('instruction', 'instructions', 'task', 'description', 'details') || title).slice(0, 1500);
      if (!title || !instruction) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); subtasks.push({ title, instruction });
      if (subtasks.length >= CUETS_MAX_SUBTASKS) break;
    }
  }
  if (subtasks.length) return { subtasks, fallback: false };
  return { subtasks: [{ title: fallbackTitle(task), instruction: task.trim().slice(0, 4000) || 'Task' }], fallback: true };
}

export function parsePlan(text: string, task: string): CuetsSubtask[] { return parsePlanDetailed(text, task).subtasks; }

/** Parses a worker reply using the same JSON shape as the normal agent mode; non-JSON replies become a plain summary. */
export function parseWorkerOutput(text: string): { summary: string; steps: CuetsStep[] } {
  const parsed: any = extractJson(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { summary: String(text ?? '').trim(), steps: [] };
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : String(text ?? '').trim();
  const steps: CuetsStep[] = (Array.isArray(parsed.steps) ? parsed.steps : []).flatMap((step: any): CuetsStep[] => {
    if (!step || typeof step.title !== 'string' || !['file', 'command', 'analysis'].includes(step.kind)) return [];
    if (step.kind === 'file') return typeof step.path === 'string' && step.path.trim() && typeof step.content === 'string' ? [{ title: step.title, kind: 'file', path: step.path.trim(), content: step.content }] : [];
    if (step.kind === 'command') return typeof step.command === 'string' && step.command.trim() ? [{ title: step.title, kind: 'command', command: step.command.trim() }] : [];
    return [{ title: step.title, kind: 'analysis' }];
  });
  return { summary, steps };
}

/** CLI models sometimes return prose/code instead of the requested proposal envelope. Repair once;
 * never silently turn a lost file proposal into a successful no-change worker. */
async function workerReply(chat: CuetsChat, messages: CuetsMessage[], signal?: AbortSignal): Promise<{ output: string; summary: string; steps: CuetsStep[] }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw abortError();
    const output = await chat(messages, signal);
    if (signal?.aborted) throw abortError();
    const raw: any = extractJson(output), parsed = parseWorkerOutput(output);
    if (raw && !Array.isArray(raw) && typeof raw.summary === 'string' && Array.isArray(raw.steps) && raw.steps.length === parsed.steps.length) return { output, ...parsed };
    messages = [...messages, { role: 'assistant', content: excerpt(output, 16000) }, { role: 'user', content: 'Your response could not be applied. Return ONLY a valid JSON object with summary (string) and steps (array). Include every proposed file as {"title":"...","kind":"file","path":"relative/path","content":"complete file content"}. Do not omit file contents or claim files were saved. If no change is needed, explain why in summary and use steps: [].' }];
  }
  throw new Error('Cuets worker returned no valid proposal JSON after one repair attempt; no changes were applied.');
}

/** Merges worker proposals; the first proposal for a file path wins and later ones are reported as conflicts. */
export function mergeWorkerSteps(workers: CuetsWorkerResult[]): { steps: CuetsStep[]; conflicts: string[] } {
  const steps: CuetsStep[] = [], conflicts: string[] = [], files = new Set<string>(), commands = new Set<string>();
  for (const worker of workers) {
    if (worker.status !== 'done') continue;
    for (const step of worker.steps) {
      if (step.kind === 'file') {
        const key = step.path!.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
        if (files.has(key)) { if (!conflicts.includes(step.path!)) conflicts.push(step.path!); continue; }
        files.add(key);
      } else if (step.kind === 'command') {
        if (commands.has(step.command!)) continue;
        commands.add(step.command!);
      }
      steps.push(step);
    }
  }
  return { steps, conflicts };
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving result order. Stops starting new items once `signal` aborts. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  const runner = async () => {
    while (next < items.length) {
      if (signal?.aborted) throw abortError();
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: items.length ? width : 0 }, runner));
  if (signal?.aborted) throw abortError();
  return results;
}

const LEAD = '(?<![\\p{L}\\p{N}_])';
const TRAIL = '(?![\\p{L}\\p{N}_])';
const EXPLICIT = new RegExp(`${LEAD}(?:multi[- ]?step|multi[- ]?agent|refactor (?:the )?(?:whole|entire)|(?:whole|entire) (?:codebase|project|app)|çok adımlı|çok ajanlı|tüm projeyi|bütün projeyi|projenin tamamını)`, 'iu');
const BUILD_EN = new RegExp(`${LEAD}(?:build|implement|refactor|migrate|migration|scaffold|set up|end[- ]to[- ]end|rewrite|redesign|integrate|across (?:the )?(?:codebase|project|files)|multiple files|several files|multi[- ]file|from scratch)${TRAIL}`, 'iu');
const BUILD_TR = new RegExp(`${LEAD}(?:uygula|geliştir|inşa et|oluştur|baştan yaz|yeniden yaz|yeniden yapılandır|refaktör|taşı|entegre et|uçtan uca|sıfırdan|birden fazla dosya|birçok dosya)`, 'iu');
const SEQUENCE = new RegExp(`${LEAD}(?:and then|after that|afterwards|then|finally|once (?:that|done)|ardından|sonra|daha sonra|en son|son olarak|ondan sonra|bunun ardından)${TRAIL}`, 'giu');
const QUESTION = new RegExp(`^\\s*(?:why|what|how|where|when|which|who|is|are|does|do|can|could|explain|neden|niye|nasıl|nedir|ne|hangi|nerede|açıkla)${TRAIL}`, 'iu');

export type AutoCuetsDecision = { multiStep: boolean; reason?: MessageKey };

/** Heuristic (no model call) deciding whether a Cude AI message is a multi-step task that should run through Cuets. */
export function autoCuetsDecision(text: string): AutoCuetsDecision {
  const value = String(text ?? '').trim();
  if (value.length < 24) return { multiStep: false };
  if (EXPLICIT.test(value)) return { multiStep: true, reason: 'cuets.reason.explicit' };
  const listItems = (value.match(/(?:^|\n)\s*(?:\d+[.)]|[-*•])\s+\S/g) || []).length;
  if (listItems >= 3) return { multiStep: true, reason: 'cuets.reason.list' };
  const fileRefs = new Set(value.match(/(?:[\w.-]+[\\/])*[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|cs|cpp|c|h|hpp|rb|php|swift|vue|svelte|html|css|scss|json|ya?ml|toml|md|sql|sh)(?![\p{L}\p{N}_])/giu) || []).size;
  if (fileRefs >= 3) return { multiStep: true, reason: 'cuets.reason.files' };
  if (value.length >= 900) return { multiStep: true, reason: 'cuets.reason.long' };
  const sequence = (value.match(SEQUENCE) || []).length;
  const clauses = value.split(/[.;!?\n]+|,\s+/).filter(part => part.trim().length >= 12).length;
  const conjunctions = (value.match(new RegExp(`${LEAD}(?:and|ve|ayrıca|also)${TRAIL}`, 'giu')) || []).length;
  const requirements = Math.max(clauses, conjunctions + 1);
  const build = BUILD_EN.test(value) || BUILD_TR.test(value);
  const question = QUESTION.test(value) && value.length < 200;
  if (build && !question && (sequence >= 1 || requirements >= 3 || value.length >= 160)) return { multiStep: true, reason: 'cuets.reason.build' };
  if (sequence >= 2 && !question) return { multiStep: true, reason: 'cuets.reason.sequence' };
  if (requirements >= 4 && value.length >= 120 && !question) return { multiStep: true, reason: 'cuets.reason.requirements' };
  return { multiStep: false };
}

export function shouldAutoCuets(text: string): boolean { return autoCuetsDecision(text).multiStep; }

const SAFETY = 'Do not assist with cheats, malware, credential theft, evasion, or unauthorized access; redirect to legal, defensive or permitted alternatives. Preserve reference licenses and attribution.';
const PLANNER_PROMPT = `You are the Cuets planner inside Cude, a coding assistant. Split the user's task into 2-4 independent, well-scoped subtasks that separate agents can work on in parallel. Return ONLY valid JSON, no prose: {"subtasks":[{"title":"short title (max 8 words)","instruction":"precise instruction for one agent, including which files or areas to inspect"}]}. If the task is genuinely small, return a single subtask. ${SAFETY}`;
const WORKER_PROMPT = `You are a Cuets worker agent inside Cude, a careful coding agent. Work only on your assigned subtask and inspect only the supplied context. Return only valid JSON: {"summary":"what you found and what you propose","steps":[{"title":"...","kind":"analysis"},{"title":"...","kind":"file","path":"workspace/relative/path","content":"complete proposed file content"},{"title":"...","kind":"command","command":"exact command"}]}. Use file steps only when you can provide complete, safe file contents. File writes and commands are proposals that the user must approve; never describe them as already executed. Prefer small steps. ${SAFETY}`;
const REVIEWER_PROMPT = `You are the Cuets reviewer inside Cude. Merge the worker agents' results into one final answer for the user. Check every result against the plan: point out gaps, contradictions, conflicting file proposals and risks, and say which proposals are ready to review. Proposed file changes and commands have NOT been applied or run; the user approves them separately, so never claim anything was changed, executed or tested. Answer in the same language as the user's task, using concise Markdown. ${SAFETY}`;

function excerpt(text: string, max: number): string { const value = String(text ?? ''); return value.length > max ? `${value.slice(0, max)}\n…[truncated]` : value; }

/** Runs the full Cuets pipeline: planner -> workers (concurrency-limited) -> reviewer (streamed). */
export async function runCuets(options: CuetsOptions): Promise<CuetsResult> {
  const { task, chat, context, label, onActivity, onDelta, signal } = options;
  const concurrency = options.concurrency ?? CUETS_CONCURRENCY;
  const ensureActive = () => { if (signal?.aborted) throw abortError(); };
  ensureActive();

  onActivity?.(label('cuets.planning'), excerpt(task, 300));
  const plannerContext = await context(undefined);
  ensureActive();
  let planText: string;
  try { planText = await chat([{ role: 'system', content: PLANNER_PROMPT }, { role: 'user', content: `Task:\n${task}\n\n${excerpt(plannerContext, 12000)}` }], signal); }
  catch (error) { if (signal?.aborted) throw abortError(); throw error; }
  ensureActive();
  const { subtasks: plan, fallback: planFallback } = parsePlanDetailed(planText, task);
  onActivity?.(planFallback ? label('cuets.planFallback') : label('cuets.planReady', { count: plan.length }), plan.map((item, index) => `${index + 1}. ${item.title}`).join('\n'));

  const workers = await mapLimit(plan, concurrency, async (subtask, index): Promise<CuetsWorkerResult> => {
    const n = index + 1;
    onActivity?.(label('cuets.agentRunning', { n, title: subtask.title }), subtask.instruction);
    try {
      const workerContext = await context(subtask);
      ensureActive();
      const { output, ...parsed } = await workerReply(chat, [{ role: 'system', content: WORKER_PROMPT }, { role: 'user', content: `Overall task:\n${task}\n\nFull plan:\n${plan.map((item, i) => `${i + 1}. ${item.title}`).join('\n')}\n\nYour subtask (${n}): ${subtask.title}\n${subtask.instruction}\n\n${workerContext}` }], signal);
      ensureActive();
      onActivity?.(label('cuets.agentDone', { n, title: subtask.title }), excerpt(parsed.summary, 600));
      return { index, title: subtask.title, instruction: subtask.instruction, status: 'done', summary: parsed.summary, steps: parsed.steps, output: excerpt(output, 8000) };
    } catch (error: any) {
      if (signal?.aborted) throw abortError();
      const message = error?.message || String(error);
      onActivity?.(label('cuets.agentFailed', { n, title: subtask.title }), message);
      return { index, title: subtask.title, instruction: subtask.instruction, status: 'failed', summary: '', steps: [], output: message };
    }
  }, signal);

  const succeeded = workers.filter(worker => worker.status === 'done');
  if (!succeeded.length) throw new Error(label('cuets.allFailed', { error: workers[0]?.output || label('cuets.unknownError') }));
  const { steps, conflicts } = mergeWorkerSteps(workers);

  ensureActive();
  onActivity?.(label('cuets.reviewing'), label('cuets.reviewDetail', { done: succeeded.length, total: workers.length }));
  const report = workers.map(worker => {
    const proposals = worker.steps.map(step => step.kind === 'file' ? `- [file] ${step.title} · ${step.path}\n\`\`\`\n${excerpt(step.content || '', 3000)}\n\`\`\`` : step.kind === 'command' ? `- [command] ${step.title}: ${step.command}` : `- [analysis] ${step.title}`).join('\n');
    return `## Agent ${worker.index + 1}: ${worker.title} (${worker.status})\nInstruction: ${worker.instruction}\n${worker.status === 'done' ? `Summary:\n${excerpt(worker.summary, 4000)}\n${proposals ? `Proposals:\n${proposals}` : 'Proposals: none'}` : `Error: ${worker.output}`}`;
  }).join('\n\n');
  let answer: string;
  try {
    answer = await chat([{ role: 'system', content: REVIEWER_PROMPT }, { role: 'user', content: `Original task:\n${task}\n\nPlan:\n${plan.map((item, i) => `${i + 1}. ${item.title}: ${item.instruction}`).join('\n')}\n\nWorker results:\n${excerpt(report, 40000)}${conflicts.length ? `\n\nConflicting file proposals (first proposal kept): ${conflicts.join(', ')}` : ''}` }], signal, onDelta);
  } catch (error) { if (signal?.aborted) throw abortError(); throw error; }
  ensureActive();
  answer = answer.trim();
  if (!answer) {
    answer = `${label('cuets.emptyAnswer')}\n\n${succeeded.map(worker => `**${worker.index + 1}. ${worker.title}**\n${worker.summary}`).join('\n\n')}`;
    onDelta?.(answer);
  }
  if (conflicts.length) answer += `\n\n${conflicts.map(file => `> ${label('cuets.conflict', { path: file })}`).join('\n')}`;
  return { plan, planFallback, workers, steps, conflicts, answer };
}

// ---------------------------------------------------------------------------------------------
// Long-running Cuets tasks: persistent checklist + round loop (plan -> work -> apply -> verify -> review).
// Everything below is pure (no vscode); the extension injects apply/verify/save callbacks.
// ---------------------------------------------------------------------------------------------

export type CuetsItemStatus = 'pending' | 'in_progress' | 'done' | 'failed';
export type CuetsChecklistItem = { id: string; title: string; instruction: string; status: CuetsItemStatus; attempts: number; note?: string; kind?: 'fix' };
export type CuetsVerification = { command: string; ok: boolean; exitCode: number | null; output: string; durationMs: number; at: number; skipped?: boolean };
export type CuetsStopReason = 'complete' | 'completeUnverified' | 'maxRounds' | 'budget' | 'cancelled' | 'noProgress' | 'blocked' | 'planOnly' | 'failed';
export type CuetsTaskStatus = 'running' | 'waiting' | 'paused' | 'done' | 'stopped' | 'discarded';
export type CuetsTaskState = {
  version: 1; id: string; goal: string; title: string; status: CuetsTaskStatus; stopReason?: CuetsStopReason;
  round: number; maxRounds: number; budgetMs: number; elapsedMs: number; noProgressRounds: number;
  createdAt: number; updatedAt: number; checklist: CuetsChecklistItem[]; notes: string[]; lastVerification?: CuetsVerification; lastSummary?: string;
};
export type CuetsVerifyCommand = { command: string; label: string; fingerprint: string };

export const CUETS_DEFAULT_MAX_ROUNDS = 8;
export const CUETS_DEFAULT_BUDGET_MS = 30 * 60_000;
export const CUETS_NO_PROGRESS_LIMIT = 2;
export const CUETS_MAX_ATTEMPTS = 3;
export const CUETS_MAX_ITEMS = 12;
export const CUETS_MAX_NOTES = 30;
export const CUETS_VERIFY_OUTPUT_MAX = 8000;
const STATUSES: readonly CuetsItemStatus[] = ['pending', 'in_progress', 'done', 'failed'];
const TASK_STATUSES: readonly CuetsTaskStatus[] = ['running', 'waiting', 'paused', 'done', 'stopped', 'discarded'];
const STOP_REASONS: readonly CuetsStopReason[] = ['complete', 'completeUnverified', 'maxRounds', 'budget', 'cancelled', 'noProgress', 'blocked', 'planOnly', 'failed'];

export function isValidTaskId(id: unknown): id is string { return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{3,63}$/.test(id); }
export function newTaskId(now: number, randomHex: string): string { return `${Math.max(0, Math.floor(now)).toString(36)}-${String(randomHex).toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 12) || '0'}`; }

/** Removes likely credentials (API keys, bearer tokens, key=value secrets) from text before it is persisted or shown. */
export function redactLikelySecrets(text: string): string {
  return String(text ?? '')
    .replace(/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|nvapi-[A-Za-z0-9_-]{20,})\b/g, '[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/gi, '$1[redacted]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|client[_-]?secret)\s*[:=]\s*)(["']?)[^\s"',;]{4,}\2/gi, '$1$2[redacted]$2');
}

/** Keeps the start and the (usually more useful) end of long command output. */
export function boundOutput(text: string, max = CUETS_VERIFY_OUTPUT_MAX): string {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.25), tail = max - head;
  return `${value.slice(0, head)}\n…[${value.length - max} characters omitted]…\n${value.slice(-tail)}`;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

export function createTaskState(goal: string, plan: CuetsSubtask[], options: { id: string; now: number; maxRounds?: number; budgetMs?: number }): CuetsTaskState {
  const text = String(goal ?? '').trim();
  const checklist = plan.slice(0, CUETS_MAX_ITEMS).map((item, index): CuetsChecklistItem => ({ id: String(index + 1), title: item.title, instruction: item.instruction, status: 'pending', attempts: 0 }));
  return {
    version: 1, id: options.id, goal: text.slice(0, 8000), title: fallbackTitle(text), status: 'running', round: 0,
    maxRounds: clampInt(options.maxRounds, 1, 200, CUETS_DEFAULT_MAX_ROUNDS), budgetMs: clampInt(options.budgetMs, 60_000, 24 * 3_600_000, CUETS_DEFAULT_BUDGET_MS),
    elapsedMs: 0, noProgressRounds: 0, createdAt: options.now, updatedAt: options.now, checklist, notes: [],
  };
}

export function taskProgress(state: Pick<CuetsTaskState, 'checklist'>): { done: number; total: number } {
  return { done: state.checklist.filter(item => item.status === 'done').length, total: state.checklist.length };
}

export function allItemsDone(state: Pick<CuetsTaskState, 'checklist'>): boolean {
  return state.checklist.length > 0 && state.checklist.every(item => item.status === 'done');
}

/** Next items to work on: interrupted (in_progress) first, then pending, then failed items that still have attempts left. */
export function pickNextItems(state: Pick<CuetsTaskState, 'checklist'>, limit = CUETS_CONCURRENCY): CuetsChecklistItem[] {
  const list = state.checklist;
  const eligible = [
    ...list.filter(item => item.status === 'in_progress'),
    ...list.filter(item => item.status === 'pending'),
    ...list.filter(item => item.status === 'failed' && item.attempts < CUETS_MAX_ATTEMPTS),
  ];
  return eligible.slice(0, Math.max(1, Math.floor(limit) || 1));
}

function hasEligibleItems(state: Pick<CuetsTaskState, 'checklist'>): boolean { return pickNextItems(state, 1).length > 0; }

/** Adds (or reopens) the synthetic "fix failing checks" item used when every item is done but verification still fails. */
export function ensureFixItem(state: CuetsTaskState, title: string, instruction: string): CuetsChecklistItem {
  const existing = state.checklist.find(item => item.kind === 'fix');
  if (existing) { existing.status = 'pending'; existing.instruction = instruction.slice(0, 1500); return existing; }
  const id = String(state.checklist.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1);
  const item: CuetsChecklistItem = { id, title: title.slice(0, 80), instruction: instruction.slice(0, 1500), status: 'pending', attempts: 0, kind: 'fix' };
  state.checklist.push(item);
  return item;
}

function normalizeStatus(value: unknown): CuetsItemStatus | undefined {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((STATUSES as readonly string[]).includes(raw)) return raw as CuetsItemStatus;
  if (['complete', 'completed', 'finished', 'ok', 'passed', 'success', 'resolved', 'tamam', 'bitti'].includes(raw)) return 'done';
  if (['todo', 'open', 'not_started', 'remaining', 'blocked_by_review', 'needs_work', 'retry'].includes(raw)) return 'pending';
  if (['in_progress', 'working', 'started', 'doing', 'partial'].includes(raw)) return 'in_progress';
  if (['error', 'blocked', 'failure', 'fail', 'broken'].includes(raw)) return 'failed';
  return undefined;
}

export type CuetsChecklistUpdate = { checklist: CuetsChecklistItem[]; parsed: boolean; summary: string; added: number };

/**
 * Parses the reviewer's checklist JSON. Accepts raw / fenced / prose-embedded JSON and a few key aliases.
 * Anything unusable (garbage, wrong shape, no recognised items) returns a copy of the previous checklist with parsed=false.
 */
export function parseChecklistUpdate(text: string, previous: readonly CuetsChecklistItem[]): CuetsChecklistUpdate {
  const copy = previous.map(item => ({ ...item }));
  const parsed: any = extractJson(text);
  const unchanged: CuetsChecklistUpdate = { checklist: copy, parsed: false, summary: '', added: 0 };
  if (!parsed || typeof parsed !== 'object') return unchanged;
  const list: unknown = Array.isArray(parsed) ? parsed : (parsed.items ?? parsed.checklist ?? parsed.updates);
  const additions: unknown = Array.isArray(parsed) ? undefined : (parsed.add ?? parsed.new ?? parsed.newItems ?? parsed.added);
  if (!Array.isArray(list) && !Array.isArray(additions)) return unchanged;
  let touched = 0, added = 0;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const raw = entry as Record<string, unknown>;
      const id = raw.id === undefined || raw.id === null ? '' : String(raw.id).trim();
      const target = copy.find(item => item.id === id) ?? (typeof raw.title === 'string' ? copy.find(item => item.title.toLowerCase() === String(raw.title).trim().toLowerCase()) : undefined);
      const status = normalizeStatus(raw.status ?? raw.state);
      if (!target || !status) continue;
      target.status = status;
      if (typeof raw.note === 'string' && raw.note.trim()) target.note = raw.note.trim().slice(0, 500);
      touched++;
    }
  }
  if (Array.isArray(additions)) {
    let nextId = copy.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
    for (const entry of additions) {
      if (copy.length >= CUETS_MAX_ITEMS || added >= 3) break;
      if (!entry || typeof entry !== 'object') continue;
      const raw = entry as Record<string, unknown>;
      const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 80) : '';
      const instruction = (typeof raw.instruction === 'string' && raw.instruction.trim() ? raw.instruction.trim() : title).slice(0, 1500);
      if (!title || copy.some(item => item.title.toLowerCase() === title.toLowerCase())) continue;
      copy.push({ id: String(nextId++), title, instruction, status: 'pending', attempts: 0 });
      added++;
    }
  }
  if (!touched && !added) return unchanged;
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 4000) : '';
  return { checklist: copy, parsed: true, summary, added };
}

/** A round made progress when more items are done than before, or verification newly passes. */
export function madeProgress(beforeDone: number, afterDone: number, before?: CuetsVerification, after?: CuetsVerification): boolean {
  if (afterDone > beforeDone) return true;
  return !!after && after.ok && !after.skipped && !(before && before.ok && !before.skipped);
}

export type CuetsStopContext = { aborted?: boolean; verificationAvailable: boolean };

/** Decides whether the loop must stop before starting another round. Order: cancel > complete > budget > rounds > no progress > blocked. */
export function evaluateStop(state: CuetsTaskState, context: CuetsStopContext): CuetsStopReason | undefined {
  if (context.aborted) return 'cancelled';
  if (allItemsDone(state)) {
    const verification = state.lastVerification;
    if (verification && verification.ok && !verification.skipped) return 'complete';
    if (!context.verificationAvailable || verification?.skipped) return 'completeUnverified';
  }
  if (state.elapsedMs >= state.budgetMs) return 'budget';
  if (state.round >= state.maxRounds) return 'maxRounds';
  if (state.noProgressRounds >= CUETS_NO_PROGRESS_LIMIT) return 'noProgress';
  if (!allItemsDone(state) && !hasEligibleItems(state)) return 'blocked';
  return undefined;
}

/** Whether a saved task can be offered for "Continue". */
export function isResumable(state: CuetsTaskState | undefined): state is CuetsTaskState {
  if (!state || state.status === 'done' || state.status === 'discarded') return false;
  return !(state.stopReason === 'complete' || state.stopReason === 'completeUnverified');
}

/** Prepares a saved task for another run: fresh round/time allowance, interrupted items back to pending. */
export function resumeTaskState(state: CuetsTaskState, options: { maxRounds?: number; budgetMs?: number; now: number }): CuetsTaskState {
  const next: CuetsTaskState = { ...state, checklist: state.checklist.map(item => ({ ...item, status: item.status === 'in_progress' ? 'pending' : item.status })), notes: [...state.notes] };
  next.maxRounds = next.round + clampInt(options.maxRounds, 1, 200, CUETS_DEFAULT_MAX_ROUNDS);
  next.budgetMs = next.elapsedMs + clampInt(options.budgetMs, 60_000, 24 * 3_600_000, CUETS_DEFAULT_BUDGET_MS);
  next.noProgressRounds = 0; next.status = 'running'; next.stopReason = undefined; next.updatedAt = options.now;
  for (const item of next.checklist) if (item.status === 'failed' && item.attempts >= CUETS_MAX_ATTEMPTS) { item.status = 'pending'; item.attempts = CUETS_MAX_ATTEMPTS - 1; }
  return next;
}

const CONTINUE = /^\s*(?:continue|resume|go on|keep going|carry on|devam(?:\s+et)?|devam edelim|sürdür|kaldığın yerden devam et)\s*[.!]*\s*$/iu;
export function isContinueCommand(text: string): boolean { return CONTINUE.test(String(text ?? '')); }

function addNote(state: CuetsTaskState, note: string) {
  const value = redactLikelySecrets(String(note ?? '').trim()).slice(0, 600);
  if (!value) return;
  state.notes.push(value);
  if (state.notes.length > CUETS_MAX_NOTES) state.notes.splice(0, state.notes.length - CUETS_MAX_NOTES);
}

function sanitizeVerification(value: any): CuetsVerification | undefined {
  if (!value || typeof value !== 'object' || typeof value.command !== 'string') return undefined;
  return {
    command: value.command.slice(0, 1000), ok: value.ok === true, exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
    output: boundOutput(redactLikelySecrets(String(value.output ?? ''))), durationMs: clampInt(value.durationMs, 0, 1e10, 0), at: clampInt(value.at, 0, 1e15, 0),
    ...(value.skipped === true ? { skipped: true } : {}),
  };
}

/** JSON for `.cude/tasks/<id>.json`; free text is passed through secret redaction and size limits. */
export function serializeTaskState(state: CuetsTaskState): string {
  const clean: CuetsTaskState = {
    version: 1, id: state.id, goal: redactLikelySecrets(state.goal).slice(0, 8000), title: redactLikelySecrets(state.title).slice(0, 120), status: state.status,
    ...(state.stopReason ? { stopReason: state.stopReason } : {}),
    round: state.round, maxRounds: state.maxRounds, budgetMs: state.budgetMs, elapsedMs: Math.round(state.elapsedMs), noProgressRounds: state.noProgressRounds,
    createdAt: state.createdAt, updatedAt: state.updatedAt,
    checklist: state.checklist.map(item => ({ id: item.id, title: redactLikelySecrets(item.title).slice(0, 80), instruction: redactLikelySecrets(item.instruction).slice(0, 1500), status: item.status, attempts: item.attempts, ...(item.note ? { note: redactLikelySecrets(item.note).slice(0, 500) } : {}), ...(item.kind ? { kind: item.kind } : {}) })),
    notes: state.notes.slice(-CUETS_MAX_NOTES).map(note => redactLikelySecrets(note).slice(0, 600)),
    ...(state.lastVerification ? { lastVerification: sanitizeVerification(state.lastVerification) } : {}),
    ...(state.lastSummary ? { lastSummary: redactLikelySecrets(state.lastSummary).slice(0, 4000) } : {}),
  };
  return `${JSON.stringify(clean, null, 2)}\n`;
}

/** Parses and validates a saved task. Returns undefined for anything malformed. */
export function parseTaskState(text: string): CuetsTaskState | undefined {
  let raw: any;
  try { raw = JSON.parse(String(text ?? '')); } catch { return undefined; }
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !isValidTaskId(raw.id) || typeof raw.goal !== 'string' || !Array.isArray(raw.checklist)) return undefined;
  const checklist: CuetsChecklistItem[] = [];
  for (const item of raw.checklist.slice(0, CUETS_MAX_ITEMS)) {
    if (!item || typeof item !== 'object' || typeof item.title !== 'string' || !item.title.trim()) continue;
    const status = normalizeStatus(item.status) ?? 'pending';
    checklist.push({ id: String(item.id ?? checklist.length + 1).slice(0, 12), title: item.title.slice(0, 80), instruction: String(item.instruction ?? item.title).slice(0, 1500), status, attempts: clampInt(item.attempts, 0, 100, 0), ...(typeof item.note === 'string' && item.note ? { note: item.note.slice(0, 500) } : {}), ...(item.kind === 'fix' ? { kind: 'fix' as const } : {}) });
  }
  const now = Date.now();
  return {
    version: 1, id: raw.id, goal: raw.goal.slice(0, 8000), title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.slice(0, 120) : fallbackTitle(raw.goal),
    status: (TASK_STATUSES as readonly string[]).includes(raw.status) ? raw.status : 'stopped',
    ...((STOP_REASONS as readonly string[]).includes(raw.stopReason) ? { stopReason: raw.stopReason } : {}),
    round: clampInt(raw.round, 0, 10_000, 0), maxRounds: clampInt(raw.maxRounds, 1, 10_000, CUETS_DEFAULT_MAX_ROUNDS), budgetMs: clampInt(raw.budgetMs, 60_000, 1e12, CUETS_DEFAULT_BUDGET_MS),
    elapsedMs: clampInt(raw.elapsedMs, 0, 1e12, 0), noProgressRounds: clampInt(raw.noProgressRounds, 0, 1000, 0),
    createdAt: clampInt(raw.createdAt, 0, 1e15, now), updatedAt: clampInt(raw.updatedAt, 0, 1e15, now), checklist,
    notes: Array.isArray(raw.notes) ? raw.notes.filter((note: unknown) => typeof note === 'string').slice(-CUETS_MAX_NOTES).map((note: string) => note.slice(0, 600)) : [],
    ...(sanitizeVerification(raw.lastVerification) ? { lastVerification: sanitizeVerification(raw.lastVerification) } : {}),
    ...(typeof raw.lastSummary === 'string' && raw.lastSummary ? { lastSummary: raw.lastSummary.slice(0, 4000) } : {}),
  };
}

const STATUS_MARK: Record<CuetsItemStatus, string> = { pending: '[ ]', in_progress: '[~]', done: '[x]', failed: '[!]' };

/** Human-readable record written next to the JSON (`.cude/tasks/<id>.md`). */
export function taskMarkdown(state: CuetsTaskState, label: CuetsLabel): string {
  const { done, total } = taskProgress(state);
  const verification = state.lastVerification;
  const lines = [
    `# ${redactLikelySecrets(state.title)}`, '',
    `- ${label('cuets.md.status')}: ${state.status}${state.stopReason ? ` (${state.stopReason})` : ''}`,
    `- ${label('cuets.round', { round: state.round, max: state.maxRounds })} · ${label('cuets.progress', { done, total })}`,
    `- ${label('cuets.md.updated')}: ${new Date(state.updatedAt).toISOString()}`, '',
    `## ${label('cuets.md.goal')}`, '', redactLikelySecrets(state.goal), '',
    `## ${label('cuets.md.checklist')}`, '',
    ...state.checklist.map(item => `- ${STATUS_MARK[item.status]} ${redactLikelySecrets(item.title)}${item.note ? ` — ${redactLikelySecrets(item.note)}` : ''}`), '',
  ];
  if (verification) lines.push(`## ${label('cuets.md.verification')}`, '', `\`${verification.command || '-'}\` → ${verification.skipped ? 'skipped' : verification.ok ? 'passed' : `failed (exit ${verification.exitCode ?? '?'})`}`, '', '```', boundOutput(redactLikelySecrets(verification.output), 3000), '```', '');
  if (state.notes.length) lines.push(`## ${label('cuets.md.notes')}`, '', ...state.notes.slice(-10).map(note => `- ${redactLikelySecrets(note).replace(/\s*\n\s*/g, ' ')}`), '');
  return lines.join('\n');
}

const NODE_SCRIPT_PLACEHOLDER = /no test specified/i;
/**
 * Cheap detection of project checks from root directory entries and a few manifest contents.
 * `entries`: names in the workspace root (files and folders). `contents`: text of package.json / pyproject.toml / setup.cfg / tox.ini when present.
 */
export function detectVerificationCommands(entries: readonly string[], contents: Readonly<Record<string, string | undefined>>): CuetsVerifyCommand[] {
  const names = new Set(entries.map(name => String(name).toLowerCase()));
  const commands: CuetsVerifyCommand[] = [];
  if (names.has('package.json')) {
    let scripts: Record<string, unknown> = {};
    try { const pkg = JSON.parse(contents['package.json'] || '{}'); if (pkg && typeof pkg.scripts === 'object' && pkg.scripts) scripts = pkg.scripts; } catch { /* malformed package.json: no node checks */ }
    const pm = names.has('pnpm-lock.yaml') ? 'pnpm' : names.has('yarn.lock') ? 'yarn' : names.has('bun.lockb') || names.has('bun.lock') ? 'bun' : 'npm';
    const run = (script: string) => pm === 'yarn' ? `yarn ${script}` : pm === 'npm' && script === 'test' ? 'npm test' : `${pm} run ${script}`;
    const has = (script: string) => typeof scripts[script] === 'string' && (scripts[script] as string).trim() && !(script === 'test' && NODE_SCRIPT_PLACEHOLDER.test(scripts[script] as string));
    const build = ['typecheck', 'compile', 'build'].find(has);
    if (build) commands.push({ command: run(build), label: build, fingerprint: `package.json:${build}:${scripts[build]}` });
    if (has('test')) commands.push({ command: run('test'), label: 'test', fingerprint: `package.json:test:${scripts.test}` });
    if (!build && !has('test') && has('lint')) commands.push({ command: run('lint'), label: 'lint', fingerprint: `package.json:lint:${scripts.lint}` });
  }
  if (names.has('cargo.toml')) commands.push({ command: 'cargo test', label: 'cargo test', fingerprint: 'Cargo.toml' });
  const pyproject = contents['pyproject.toml'] || '', setupCfg = contents['setup.cfg'] || '', tox = contents['tox.ini'] || '';
  const pythonProject = names.has('pyproject.toml') || names.has('setup.py') || names.has('setup.cfg') || names.has('requirements.txt');
  const pytest = names.has('pytest.ini') || names.has('conftest.py') || /\[tool\.pytest/.test(pyproject) || /\[tool:pytest\]/.test(setupCfg) || /\[pytest\]/.test(tox) || (pythonProject && (names.has('tests') || names.has('test')));
  if (pytest) commands.push({ command: 'python -m pytest -q', label: 'pytest', fingerprint: 'pytest' });
  if (names.has('go.mod')) commands.push({ command: 'go test ./...', label: 'go test', fingerprint: 'go.mod' });
  return commands.slice(0, 3);
}

export type CuetsApplyResult = { applied: number; failed: string[]; pending?: number; stop?: boolean };
export type CuetsLoopPhase = 'planning' | 'working' | 'applying' | 'verifying' | 'reviewing' | 'stopped';
export type CuetsRoundInfo ={ round: number; items: CuetsChecklistItem[]; workers: CuetsWorkerResult[] };
export type CuetsLoopOptions = {
  goal: string;
  /** Saved state to resume (already passed through resumeTaskState); omitted for a new task. */
  state?: CuetsTaskState;
  id: string;
  maxRounds?: number;
  budgetMs?: number;
  /** 'plan' (plan/readonly permission): plan + one proposal round, nothing applied or run. */
  mode: 'execute' | 'plan';
  chat: CuetsChat;
  context: (item?: CuetsChecklistItem) => Promise<string>;
  label: CuetsLabel;
  applySteps: (steps: CuetsStep[], round: CuetsRoundInfo) => Promise<CuetsApplyResult>;
  /** Runs the project checks; undefined result = nothing to run. */
  verify?: () => Promise<CuetsVerification | undefined>;
  verificationAvailable: boolean;
  save: (state: CuetsTaskState) => Promise<void>;
  onProgress?: (state: CuetsTaskState, phase: CuetsLoopPhase) => void;
  onActivity?: (label: string, detail: string) => void;
  signal?: AbortSignal;
  concurrency?: number;
  now?: () => number;
};
export type CuetsLoopResult = { state: CuetsTaskState; stopReason: CuetsStopReason; summary: string; lastSteps: CuetsStep[] };

const LOOP_WORKER_PROMPT = `You are a Cuets worker agent inside Cude, a careful coding agent. You work on ONE checklist item of a longer task that runs over several rounds until the goal is done and the project checks pass. Inspect only the supplied context (it reflects the current files, including changes from earlier rounds). Return only valid JSON: {"summary":"what you found and what you changed or propose","steps":[{"title":"...","kind":"analysis"},{"title":"...","kind":"file","path":"workspace/relative/path","content":"complete new file content, or one or more <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks for an existing file"},{"title":"...","kind":"command","command":"exact command"}]}. If the item is already satisfied by the current code, return no file steps and say so. If the last project check failed, fix the cause shown in its output. File writes go through Cude's review/apply flow; never claim they were applied, run or tested. Prefer small, complete steps. ${SAFETY}`;
const LOOP_REVIEWER_PROMPT = `You are the Cuets reviewer for a long-running coding task. Update the checklist from this round's evidence: worker results, which file changes were actually applied, and the latest project check result. Mark an item "done" only if its work was applied (or it needed no change) and the check output does not contradict it; "failed" if the attempt clearly failed; otherwise keep it "pending". You may add up to 3 new items for missing work. Never claim tests passed unless the check result says so. Return ONLY JSON: {"summary":"2-4 sentences for the user, in the language of the goal","items":[{"id":"1","status":"done|pending|failed","note":"short reason"}],"add":[{"title":"short title","instruction":"precise instruction"}]}. ${SAFETY}`;

function checklistText(items: readonly CuetsChecklistItem[]): string {
  return items.map(item => `${item.id}. [${item.status}] ${item.title}${item.note ? ` — ${item.note}` : ''}`).join('\n');
}
function verificationText(verification: CuetsVerification | undefined): string {
  if (!verification) return 'No project check has run yet.';
  if (verification.skipped) return `Project check \`${verification.command}\` was skipped (not approved or not allowed).`;
  return `Project check \`${verification.command}\` ${verification.ok ? 'PASSED' : `FAILED (exit ${verification.exitCode ?? 'unknown'})`}.\nOutput (bounded):\n${boundOutput(verification.output, 6000)}`;
}

/** Runs the long-running Cuets loop until the goal is done and verified, a budget is exhausted, it is cancelled, or it stalls. */
export async function runCuetsLoop(options: CuetsLoopOptions): Promise<CuetsLoopResult> {
  const { chat, label, signal, onActivity } = options;
  const now = options.now ?? Date.now;
  const concurrency = options.concurrency ?? CUETS_CONCURRENCY;
  let verificationAvailable = options.verificationAvailable && !!options.verify;
  let lastSteps: CuetsStep[] = [];
  let mark = now();
  const progress = (phase: CuetsLoopPhase) => options.onProgress?.(state, phase);
  const tick = () => { const t = now(); state.elapsedMs += Math.max(0, t - mark); mark = t; state.updatedAt = t; };
  const save = async () => { tick(); await options.save(state); };

  let state: CuetsTaskState;
  if (options.state) state = options.state;
  else {
    onActivity?.(label('cuets.planning'), excerpt(options.goal, 300));
    const plannerContext = await options.context(undefined);
    if (signal?.aborted) throw abortError();
    let planText: string;
    try { planText = await chat([{ role: 'system', content: PLANNER_PROMPT }, { role: 'user', content: `Task:\n${options.goal}\n\n${excerpt(plannerContext, 12000)}` }], signal); }
    catch (error) { if (signal?.aborted) throw abortError(); throw error; }
    const { subtasks, fallback } = parsePlanDetailed(planText, options.goal);
    state = createTaskState(options.goal, subtasks, { id: options.id, now: now(), maxRounds: options.maxRounds, budgetMs: options.budgetMs });
    onActivity?.(fallback ? label('cuets.planFallback') : label('cuets.planReady', { count: subtasks.length }), subtasks.map((item, index) => `${index + 1}. ${item.title}`).join('\n'));
  }
  state.status = 'running';
  await save(); progress('planning');

  const finish = async (reason: CuetsStopReason): Promise<CuetsLoopResult> => {
    for (const item of state.checklist) if (item.status === 'in_progress') item.status = 'pending';
    state.stopReason = reason;
    state.status = reason === 'complete' || reason === 'completeUnverified' ? 'done' : reason === 'planOnly' ? 'paused' : 'stopped';
    await save(); progress('stopped');
    const { done, total } = taskProgress(state);
    const stopText = label(`cuets.stop.${reason}` as MessageKey, { max: state.maxRounds, minutes: Math.round(state.budgetMs / 60_000) });
    const lines = [`**${stopText}**`, '', `${label('cuets.round', { round: state.round, max: state.maxRounds })} · ${label('cuets.progress', { done, total })}`, '', ...state.checklist.map(item => `- ${item.status === 'done' ? '✓' : item.status === 'failed' ? '✗' : '○'} ${item.title}${item.note ? ` — ${item.note}` : ''}`)];
    const verification = state.lastVerification;
    if (verification) lines.push('', verification.skipped ? label('cuets.verifySkipped') : verification.ok ? label('cuets.verifyPassed', { command: verification.command }) : label('cuets.verifyFailed', { command: verification.command }));
    else if (!verificationAvailable && options.mode === 'execute') lines.push('', label('cuets.verifyNone'));
    if (state.lastSummary) lines.push('', state.lastSummary);
    return { state, stopReason: reason, summary: lines.join('\n'), lastSteps };
  };

  const runVerify = async () => {
    if (!options.verify || !verificationAvailable) return;
    tick(); progress('verifying');
    const result = await options.verify();
    mark = now();
    if (signal?.aborted) throw abortError();
    if (!result) { verificationAvailable = false; return; }
    state.lastVerification = sanitizeVerification(result);
    onActivity?.(result.skipped ? label('cuets.verifySkipped') : result.ok ? label('cuets.verifyPassed', { command: result.command }) : label('cuets.verifyFailed', { command: result.command }), result.skipped ? result.command : boundOutput(result.output, 1500));
  };

  try {
    while (true) {
      if (signal?.aborted) return await finish('cancelled');
      // All items done but checks never ran: run them once before deciding.
      if (options.mode === 'execute' && allItemsDone(state) && verificationAvailable && !state.lastVerification) { await runVerify(); await save(); continue; }
      // All items done but checks fail: reopen work as a "fix checks" item.
      const failing = state.lastVerification && !state.lastVerification.ok && !state.lastVerification.skipped;
      if (options.mode === 'execute' && allItemsDone(state) && failing && state.round < state.maxRounds && state.elapsedMs < state.budgetMs && state.noProgressRounds < CUETS_NO_PROGRESS_LIMIT) {
        ensureFixItem(state, label('cuets.fixChecks'), label('cuets.fixChecksDetail', { command: state.lastVerification!.command }));
      }
      const stop = evaluateStop(state, { aborted: signal?.aborted, verificationAvailable: verificationAvailable && options.mode === 'execute' });
      if (stop) return await finish(stop);

      const items = pickNextItems(state, concurrency);
      const beforeDone = taskProgress(state).done, beforeVerification = state.lastVerification;
      state.round++;
      for (const item of items) { item.status = 'in_progress'; item.attempts++; }
      await save(); progress('working');
      onActivity?.(label('cuets.roundStart', { round: state.round, max: state.maxRounds }), items.map(item => `${item.id}. ${item.title}`).join('\n'));

      const workers = await mapLimit(items, concurrency, async (item, index): Promise<CuetsWorkerResult> => {
        const n = index + 1;
        onActivity?.(label('cuets.agentRunning', { n, title: item.title }), item.instruction);
        try {
          const workerContext = await options.context(item);
          if (signal?.aborted) throw abortError();
          const { output, ...parsed } = await workerReply(chat, [{ role: 'system', content: LOOP_WORKER_PROMPT }, { role: 'user', content: `Overall goal:\n${state.goal}\n\nChecklist (round ${state.round}/${state.maxRounds}):\n${checklistText(state.checklist)}\n\nYour item (${item.id}): ${item.title}\n${item.instruction}${item.note ? `\nPrevious note: ${item.note}` : ''}\n\nLatest project check:\n${verificationText(state.lastVerification)}\n\n${state.notes.length ? `Recent notes:\n${state.notes.slice(-5).join('\n')}\n\n` : ''}${workerContext}` }], signal);
          if (signal?.aborted) throw abortError();
          onActivity?.(label('cuets.agentDone', { n, title: item.title }), excerpt(parsed.summary, 600));
          return { index, title: item.title, instruction: item.instruction, status: 'done', summary: parsed.summary, steps: parsed.steps, output: excerpt(output, 8000) };
        } catch (error: any) {
          if (signal?.aborted) throw abortError();
          const message = error?.message || String(error);
          onActivity?.(label('cuets.agentFailed', { n, title: item.title }), message);
          return { index, title: item.title, instruction: item.instruction, status: 'failed', summary: '', steps: [], output: message };
        }
      }, signal);

      const { steps, conflicts } = mergeWorkerSteps(workers);
      lastSteps = steps;
      if (conflicts.length) addNote(state, `Round ${state.round}: ${conflicts.map(file => label('cuets.conflict', { path: file })).join(' ')}`);
      if (!workers.some(worker => worker.status === 'done')) {
        items.forEach((item, index) => { item.status = 'failed'; item.note = excerpt(workers[index]?.output || label('cuets.unknownError'), 300); });
        addNote(state, `Round ${state.round}: ${label('cuets.allFailed', { error: workers[0]?.output || label('cuets.unknownError') })}`);
        state.noProgressRounds++;
        await save(); progress('reviewing');
        continue;
      }

      if (options.mode === 'plan') {
        workers.forEach((worker, index) => { if (worker.status === 'done' && worker.summary) items[index].note = excerpt(worker.summary, 300); });
        state.lastSummary = workers.filter(worker => worker.status === 'done').map(worker => `**${worker.title}** — ${excerpt(worker.summary, 600)}`).join('\n\n');
        return await finish('planOnly');
      }

      tick(); progress('applying');
      const applied = await options.applySteps(steps, { round: state.round, items, workers });
      mark = now();
      if (applied.stop || signal?.aborted) return await finish('cancelled');
      if (applied.failed.length) addNote(state, `Round ${state.round}: ${label('cuets.applyFailed')}: ${applied.failed.join('; ')}`);

      if (applied.applied > 0 || !state.lastVerification) await runVerify();

      // Reviewer updates the checklist; unusable replies keep the previous state.
      tick(); progress('reviewing');
      onActivity?.(label('cuets.reviewRound'), label('cuets.reviewDetail', { done: workers.filter(worker => worker.status === 'done').length, total: workers.length }));
      const report = workers.map(worker => {
        const proposals = worker.steps.map(step => step.kind === 'file' ? `- [file] ${step.title} · ${step.path}` : step.kind === 'command' ? `- [command] ${step.title}: ${step.command}` : `- [analysis] ${step.title}`).join('\n');
        return `## Item ${items[worker.index].id}: ${worker.title} (${worker.status})\n${worker.status === 'done' ? `Summary:\n${excerpt(worker.summary, 3000)}\n${proposals ? `Proposals:\n${proposals}` : 'Proposals: none'}` : `Error: ${worker.output}`}`;
      }).join('\n\n');
      const applyText = `Applied file changes this round: ${applied.applied}.${applied.pending ? ` Not applied (awaiting/declined by user): ${applied.pending}.` : ''}${applied.failed.length ? ` Failed to apply: ${applied.failed.join('; ')}` : ''}`;
      let update: CuetsChecklistUpdate;
      try {
        const reply = await chat([{ role: 'system', content: LOOP_REVIEWER_PROMPT }, { role: 'user', content: `Goal:\n${state.goal}\n\nChecklist before this round:\n${checklistText(state.checklist)}\n\nWorked on this round: ${items.map(item => item.id).join(', ')}\n\n${excerpt(report, 30000)}\n\n${applyText}\n\nLatest project check:\n${verificationText(state.lastVerification)}` }], signal);
        update = parseChecklistUpdate(reply, state.checklist);
      } catch (error: any) {
        if (signal?.aborted) throw abortError();
        update = { checklist: state.checklist.map(item => ({ ...item })), parsed: false, summary: '', added: 0 };
        addNote(state, `Round ${state.round}: reviewer error: ${error?.message || String(error)}`);
      }
      if (!update.parsed) {
        addNote(state, `Round ${state.round}: ${label('cuets.reviewParseFailed')}`);
        onActivity?.(label('cuets.reviewParseFailed'), '');
      }
      state.checklist = update.checklist.map(item => ({ ...item, status: item.status === 'in_progress' ? 'pending' : item.status }));
      // A reviewer is not evidence of a successful disk write. Keep failed, declined,
      // unsaved or conflicting work open even when the model reports it as done.
      const incompleteApply = applied.failed.length > 0 || !!applied.pending || applied.applied < steps.filter(step => step.kind === 'file').length;
      for (const [index, worked] of items.entries()) {
        const item = state.checklist.find(candidate => candidate.id === worked.id);
        if (item?.status === 'done' && (workers[index].status === 'failed' || incompleteApply || conflicts.length > 0)) {
          item.status = 'pending';
          item.note = 'Work was not fully applied and saved; retry with current file context.';
        }
      }
      if (update.summary) state.lastSummary = update.summary;
      const afterDone = taskProgress(state).done;
      state.noProgressRounds = madeProgress(beforeDone, afterDone, beforeVerification, state.lastVerification) ? 0 : state.noProgressRounds + 1;
      await save(); progress('reviewing');
    }
  } catch (error: any) {
    if (signal?.aborted || error?.name === 'AbortError') return await finish('cancelled');
    addNote(state, `Round ${state.round}: ${error?.message || String(error)}`);
    const result = await finish('failed');
    result.summary = `${label('cuets.stop.failed', { error: error?.message || String(error) })}\n\n${result.summary.split('\n').slice(2).join('\n')}`;
    return result;
  }
}
