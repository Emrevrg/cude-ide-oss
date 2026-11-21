// Iterative agent for Cude AI: the model calls one tool per turn, sees the real result and continues until it
// gives a final answer. Works with every provider because the protocol is plain JSON in the reply text.
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { hasHiddenCommandCharacters, isSecretPath } from './security';
import {activityGate} from './updatePolicy';
import { EXTRA_READ_TOOLS, EXTRA_WRITE_TOOLS, extraToolList, runExtraTool } from './agentTools';
import { COMPUTER_READ_TOOLS, COMPUTER_WRITE_TOOLS } from './appBridge';
import { extractImagePaths } from './computerUse';
import * as os from 'node:os';
const STATEFUL_TOOLS = new Set([...COMPUTER_READ_TOOLS, ...COMPUTER_WRITE_TOOLS, 'diagnostics', 'git', 'todo']);

export type LoopPermission = 'ask' | 'auto' | 'plan' | 'readonly' | 'full';
export type LoopMessage = { role: 'system' | 'user' | 'assistant'; content: string; images?: string[] };
export type LoopAction = { thought?: string; tool?: string; args?: Record<string, any>; final?: string };
export type LoopEvents = { activity: (label: string, detail: string) => void; status?: (text: string) => void };
export type LoopText = (key: string, values?: Record<string, string | number>) => string;
export type LoopCheckpoint = { summary: string; reason: 'limit' | 'error'; steps: number };
export type LoopOptions = {
  localModel?: boolean; task: string; workspace: string; permission: LoopPermission; context?: string;
  chat: (messages: LoopMessage[], signal?: AbortSignal) => Promise<string>;
  /** false = never send screenshots as images (text UI element list only). */
  images?: boolean;
  mcpTools?: Array<{ server: string; name: string; description: string }>;
  callMcp?: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;
  confirm: (message: string, detail: string, action: string) => Promise<boolean>;
  events: LoopEvents; text: LoopText; signal?: AbortSignal; maxSteps?: number; maxMinutes?: number;
  continueAfter?: (checkpoint: LoopCheckpoint) => Promise<boolean>;
};

const MAX_OBSERVATION = 12000;
const READ_TOOLS = ['list_files', 'read_file', 'search', ...EXTRA_READ_TOOLS];
const WRITE_TOOLS = ['write_file', 'edit_file', 'run_command', ...EXTRA_WRITE_TOOLS];
const IGNORED = /(^|[\\/])(node_modules|\.git|dist|out|build|\.next|\.venv|venv|__pycache__|\.cude[\\/]index)([\\/]|$)/i;
const clip = (text: string, limit = MAX_OBSERVATION) => text.length > limit ? `${text.slice(0, limit)}\n…[${text.length - limit} more characters]` : text;

/** Finds the first JSON object in a model reply (tolerates code fences and surrounding prose). */
export function parseAction(reply: string): LoopAction | undefined {
  const text = reply.replace(/```(?:json)?/gi, '').trim();
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) { try { const value = JSON.parse(text.slice(start, i + 1)); if (value && typeof value === 'object' && (typeof value.tool === 'string' || typeof value.final === 'string')) return value; } catch { } break; } }
    }
  }
  return undefined;
}

/** Resolves a workspace-relative path and refuses anything outside the project or pointing at secrets. */
export function insideWorkspace(workspace: string, relative: string): string {
  const raw = String(relative || '.').replace(/^[\\/]+/, '');
  const full = path.resolve(workspace, raw), rootPath = path.resolve(workspace);
  const rel = path.relative(rootPath, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('PATH_OUTSIDE');
  if (rel && isSecretPath(rel)) throw new Error('PATH_SECRET');
  return full;
}

async function walk(dir: string, rootPath: string, out: string[], limit: number) {
  let entries: import('node:fs').Dirent[]; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= limit) return;
    const full = path.join(dir, entry.name), rel = path.relative(rootPath, full);
    if (IGNORED.test(rel) || entry.name.startsWith('.env')) continue;
    if (entry.isDirectory()) await walk(full, rootPath, out, limit); else if (entry.isFile()) out.push(rel.split(path.sep).join('/'));
  }
}

function toolList(o: LoopOptions) {
  const writes = o.permission !== 'plan' && o.permission !== 'readonly';
  const lines = [
    'list_files {"path":"folder (optional)"} — list project files (up to 300).',
    'read_file {"path":"file","start_line":1,"end_line":200} — read part of a file with line numbers.',
    'search {"pattern":"text or regex","path":"folder (optional)"} — search the project (up to 60 matches).',
  ];
  if (writes) lines.push(
    'write_file {"path":"file","content":"full new content"} — create or replace a file.',
    'edit_file {"path":"file","old_text":"exact unique text","new_text":"replacement"} — change one exact snippet.',
    'run_command {"command":"exact shell command","timeout_seconds":120} — run in the project folder after the user approves; you receive the output.');
  lines.push(...extraToolList(writes));
  if (o.mcpTools?.length && o.callMcp) lines.push(`mcp {"server":"name","tool":"name","arguments":{...}} — call an approved MCP tool (browser, computer, search). Available: ${o.mcpTools.slice(0, 60).map(t => `${t.server}.${t.name}`).join(', ')}`);
  // Small local models have short context windows: keep only the call shape, drop the prose.
  if (o.localModel) return lines.filter(l => !/^Computer and browser rules/.test(l)).map(l => l.split(' — ')[0]).join('\n');
  return lines.join('\n');
}

export function loopSystemPrompt(o: LoopOptions) {
  if(o.localModel)return `You are Cude. Reply with ONE JSON object: {"tool":"name","args":{}} or {"final":"answer"}. Inspect before editing. Never invent results. Respect approvals and project rules. Permission: ${o.permission}. Tools:\n${toolList(o)}`;
  return `You are Cude, a careful autonomous coding agent working inside the user's project (${path.basename(o.workspace)}).
Work step by step with tools. Every reply must be exactly ONE JSON object and nothing else:
{"thought":"one short sentence","tool":"<tool name>","args":{...}}  to use a tool, or
{"final":"your answer to the user in markdown"}  when the task is done or cannot continue.
Tools:
${toolList(o)}
Rules: prefer grep/glob/symbols/definition/references to understand code quickly; check diagnostics after edits; keep a todo checklist for multi-step tasks; inspect files before changing them; make small correct edits; after edits run the project's tests or build when one exists; read tool results carefully and fix problems you see; never invent tool output; do not repeat the same failing call more than twice; if the user declines an action, adapt or finish. Permission mode: ${o.permission}${o.permission === 'plan' || o.permission === 'readonly' ? ' (read-only: do not try to write or run commands; answer with a plan)' : ''}.
Do not assist with malware, credential theft, cheating or unauthorized access.`;
}

async function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const win = process.platform === 'win32';
  return new Promise(resolve => {
    // cmd.exe needs the command verbatim inside one pair of quotes (/s), otherwise inner quotes get mangled.
    const child = win
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd, windowsHide: true, windowsVerbatimArguments: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } })
      : spawn('/bin/sh', ['-c', command], { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let out = '', done = false;
    const finish = (suffix: string) => { if (done) return; done = true; clearTimeout(timer); resolve(clip(out + suffix, 16000)); };
    const timer = setTimeout(() => { try { child.kill(); } catch { } finish(`\n[stopped after ${Math.round(timeoutMs / 1000)} s]`); }, timeoutMs);
    signal?.addEventListener('abort', () => { try { child.kill(); } catch { } finish('\n[cancelled]'); }, { once: true });
    const take = (chunk: Buffer) => { out += chunk.toString('utf8'); if (out.length > 200000) out = out.slice(-100000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('error', error => finish(`\n[could not start: ${error.message}]`));
    child.on('close', code => finish(`\n[exit code ${code}]`));
  });
}

async function writeWithUndo(full: string, content: string) {
  const uri = vscode.Uri.file(full);
  let exists = true; try { await fs.stat(full); } catch { exists = false; }
  const edit = new vscode.WorkspaceEdit();
  if (!exists) { await fs.mkdir(path.dirname(full), { recursive: true }); edit.createFile(uri, { ignoreIfExists: true }); edit.insert(uri, new vscode.Position(0, 0), content); }
  else { const doc = await vscode.workspace.openTextDocument(uri); edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content); }
  if (!await vscode.workspace.applyEdit(edit)) throw new Error('EDIT_REJECTED');
  const doc = await vscode.workspace.openTextDocument(uri); await doc.save();
}

/** Runs one tool call and returns the observation text the model will see. Errors become observations, never crashes. */
export async function runTool(o: LoopOptions, action: LoopAction): Promise<string> {
  const args = action.args && typeof action.args === 'object' ? action.args : {};
  const t = o.text, ws = o.workspace, writes = o.permission !== 'plan' && o.permission !== 'readonly';
  try {
    switch (action.tool) {
      case 'list_files': {
        const base = insideWorkspace(ws, args.path || '.'), files: string[] = []; await walk(base, ws, files, 300);
        return files.length ? files.join('\n') : '(no files)';
      }
      case 'read_file': {
        const full = insideWorkspace(ws, args.path); const stat = await fs.stat(full); if (stat.size > 2_000_000) return 'File is larger than 2 MB; read a smaller part with search first.';
        const lines = (await fs.readFile(full, 'utf8')).split(/\r?\n/); const start = Math.max(1, Number(args.start_line) || 1), end = Math.min(lines.length, Number(args.end_line) || start + 299);
        return clip(lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n') + (end < lines.length ? `\n… (${lines.length} lines total)` : ''));
      }
      case 'search': {
        const pattern = String(args.pattern || ''); if (!pattern) return 'Give a pattern.';
        let re: RegExp; try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
        const base = insideWorkspace(ws, args.path || '.'), files: string[] = []; await walk(base, ws, files, 4000); const hits: string[] = [];
        for (const rel of files) { if (hits.length >= 60) break; if (/\.(png|jpe?g|gif|ico|exe|dll|zip|gguf|bin|pdf|woff2?|mp4|lock)$/i.test(rel)) continue; let text: string; try { const full = path.join(ws, rel); if ((await fs.stat(full)).size > 500_000) continue; text = await fs.readFile(full, 'utf8'); } catch { continue; } const lines = text.split(/\r?\n/); for (let i = 0; i < lines.length && hits.length < 60; i++) if (re.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`); }
        return hits.length ? hits.join('\n') : 'No matches.';
      }
      case 'write_file': case 'edit_file': {
        if (!writes) return t('loop.readOnly');
        const full = insideWorkspace(ws, args.path), rel = path.relative(ws, full);
        let next: string;
        if (action.tool === 'write_file') { if (typeof args.content !== 'string') return 'content must be a string.'; next = args.content; }
        else { let current: string; try { current = await fs.readFile(full, 'utf8'); } catch { return `File not found: ${rel}`; } const oldText = String(args.old_text ?? ''); const count = oldText ? current.split(oldText).length - 1 : 0; if (count !== 1) return count === 0 ? 'old_text was not found exactly; read the file again and copy the exact text.' : `old_text appears ${count} times; include more surrounding lines so it is unique.`; next = current.replace(oldText, () => String(args.new_text ?? '')); }
        if (Buffer.byteLength(next) > 1_500_000) return 'Content is larger than 1.5 MB; split the change.';
        if (o.permission === 'ask' && !await o.confirm(t('loop.confirmWrite', { file: rel }), next.slice(0, 1500), t('loop.write'))) return 'The user declined this edit.';
        activityGate.assertAllowed();
        await writeWithUndo(full, next); o.events.activity(t('loop.wrote', { file: rel }), `${Buffer.byteLength(next)} bytes`);
        return `Saved ${rel}. The user can undo it with Ctrl+Z in the editor.`;
      }
      case 'run_command': {
        if (!writes) return t('loop.readOnly');
        const command = String(args.command || '').trim(); if (!command) return 'Give a command.';
        if (command.length > 4000 || hasHiddenCommandCharacters(command)) return 'This command contains hidden or unsafe characters and was not run.';
        if (!await o.confirm(t('loop.confirmCommand'), command, t('loop.run'))) return 'The user declined to run this command.';
        activityGate.assertAllowed();
        o.events.activity(t('loop.running'), command);
        return await runShell(command, ws, Math.min(600, Math.max(5, Number(args.timeout_seconds) || 120)) * 1000, o.signal);
      }
      case 'mcp': {
        if (!o.callMcp || !o.mcpTools?.length) return 'No MCP tools are configured. Run "Cude AI: Add Agent Tools" first.';
        const server = String(args.server || ''), tool = String(args.tool || ''), toolArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments : {};
        if (!o.mcpTools.some(item => item.server === server && item.name === tool)) return `Unknown MCP tool ${server}.${tool}. Use one from the list.`;
        return clip(await o.callMcp(server, tool, toolArgs));
      }
      default: {
        const extra = await runExtraTool({ workspace: ws, permission: o.permission, signal: o.signal, inside: relative => insideWorkspace(ws, relative), confirm: o.confirm, write: async (full, content) => { activityGate.assertAllowed(); await writeWithUndo(full, content); }, activity: o.events.activity }, String(action.tool), args);
        return extra ?? `Unknown tool "${action.tool}". Use one of the listed tools or reply with {"final":"..."}.`;
      }
    }
  } catch (error: any) {
    const code = String(error?.message || error);
    if (code === 'PATH_OUTSIDE') return 'That path is outside the project and was refused.';
    if (code === 'PATH_SECRET') return 'That path looks like a secret file and was refused.';
    if (error?.code === 'ENOENT') return `Not found: ${args.path || ''}`;
    return `Tool error: ${code.slice(0, 400)}`;
  }
}

/** Each round has its own budget. A continued round keeps the task and tool observations. */
export async function runAgentLoop(o: LoopOptions): Promise<{ final: string; steps: number; stopped: 'done' | 'limit' | 'cancelled' | 'error' }> {
  const maxSteps = o.maxSteps ?? 30;
  const messages: LoopMessage[] = [{ role: 'system', content: loopSystemPrompt(o) }, { role: 'user', content: `Task: ${o.task}${o.context ? `\n\nProject context:\n${o.context}` : ''}` }];
  const observations: string[] = [];
  let malformed = 0, steps = 0;
  const cancelled = () => ({ final: o.text('loop.cancelled'), steps, stopped: 'cancelled' as const });
  const budget = o.localModel ? 20000 : 60000;
  const validTools = new Set([...READ_TOOLS, ...WRITE_TOOLS]);
  if (o.mcpTools?.length && o.callMcp) validTools.add('mcp');
  for (;;) {
    const duration = Math.max(0, Math.floor((o.maxMinutes ?? 20) * 60_000));
    const roundTimeout = AbortSignal.timeout(duration);
    const roundSignal = o.signal ? AbortSignal.any([o.signal,roundTimeout]) : roundTimeout;
    const deadline = Date.now() + duration;
    let providerErrors = 0;
    const calls = new Map<string, number>();
    let answerOnly = false;
    let imagesOff = o.images === false;
    let checkpoint: LoopCheckpoint = { summary: '', reason: 'limit', steps };
    for (let step = 1; step <= maxSteps; step++) {
      if (o.signal?.aborted) return cancelled();
      if (Date.now() >= deadline) break;
      o.events.status?.(o.text('loop.step', { step, max: maxSteps }));
      let reply: string;
      try {
        const history: LoopMessage[] = answerOnly ? [
          { role: 'system', content: 'Tools are disabled. Answer the task in plain text using the supplied context and observations. If information is missing, say so.' },
          { role: 'user', content: `${messages[1].content}\n\nObservations:\n${clip(observations.join('\n\n'), 6000)}` },
        ] : trimHistory(messages,budget);
        // Screenshots: only the newest image travels to the model; older turns keep their text description.
        const lastImage = imagesOff ? -1 : history.map(m => !!m.images?.length).lastIndexOf(true);
        const wire = history.map((m, i) => i === lastImage ? { role: m.role, content: [{ type: 'text', text: m.content }, ...m.images!.map(url => ({ type: 'image_url', image_url: { url } }))] } : { role: m.role, content: m.content });
        try { reply = await o.chat(wire as any, roundSignal); }
        catch (error) {
          if (lastImage < 0 || o.signal?.aborted) throw error;
          // The model probably has no image input: continue with the text-only UI element list.
          imagesOff = true;
          reply = await o.chat(history.map(m => ({ role: m.role, content: m.content })), roundSignal);
        }
        providerErrors = 0;
      }
      catch (error: any) {
        if (o.signal?.aborted) return cancelled();
        if (roundTimeout.aborted || Date.now() >= deadline) break;
        if (++providerErrors <= 2) {
          o.events.activity(o.text('loop.retry'), String(error?.message || error).slice(0, 200));
          await delay(1500 * providerErrors, undefined, { signal: o.signal }).catch(() => {});
          step--;
          continue;
        }
        checkpoint = { summary: `${o.text('loop.providerPaused')}\n\n${String(error?.message || error).slice(0, 400)}`, reason: 'error', steps };
        break;
      }
      if (o.signal?.aborted) return cancelled();
      steps++;
      const action = parseAction(reply);
      if (answerOnly) {
        if (!action?.tool) return { final: (action?.final ?? reply).trim() || o.text('loop.noAnswer'), steps, stopped: 'done' };
        checkpoint = { summary: o.text('loop.repeatedTools'), reason: 'error', steps };
        break;
      }
      if (!action) {
        if (++malformed > (o.localModel?5:2)) return { final: reply.trim() || o.text('loop.noAnswer'), steps, stopped: 'done' };
        messages.push({ role: 'assistant', content: reply.slice(0, 4000) }, { role: 'user', content: 'Reply with exactly one JSON object: {"thought":"...","tool":"...","args":{...}} or {"final":"..."}.' });
        continue;
      }
      malformed = 0;
      if (typeof action.final === 'string' && !action.tool) return { final: action.final, steps, stopped: 'done' };
      const tool = String(action.tool);
      const assistant: LoopMessage = { role: 'assistant', content: JSON.stringify({ thought: action.thought, tool, args: action.args }) };
      if (!validTools.has(tool)) {
        messages.push(assistant, { role: 'user', content: 'That tool is unavailable. Use one of the listed tools or reply with {"final":"..."}.' });
        continue;
      }
      if ((o.permission === 'plan' || o.permission === 'readonly') && WRITE_TOOLS.includes(tool)) {
        messages.push(assistant, { role: 'user', content: o.text('loop.readOnly') });
        continue;
      }
      const signature = JSON.stringify([tool, action.args ?? {}], (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
          : value);
      const count = (calls.get(signature) ?? 0) + 1;
      calls.set(signature, count);
      if (count > 1 && !(STATEFUL_TOOLS.has(tool) && count <= 4)) {
        answerOnly = count >= 3;
        messages.push(assistant, { role: 'user', content: answerOnly
          ? 'The same call was requested again. Tools are disabled for the next reply. Answer the original task using the observations.'
          : 'You already made this exact call. Use the earlier result or try something different.' });
        if (answerOnly && step === maxSteps) step--;
        continue;
      }
      o.events.activity(o.text('loop.tool', { tool: o.text(`loop.toolName.${tool}`) }), (action.thought || summarizeArgs(action.args)).slice(0, 240));
      activityGate.assertAllowed();
      const observation = await runTool(o, action);
      observations.push(clip(observation, 2000));
      if(observations.length>4)observations.shift();
      messages.push(assistant, { role: 'user', content: `Result of ${tool}:\n${observation}`, images: imagesOff ? undefined : await screenshotImages(observation) });
    }
    if (o.signal?.aborted) return cancelled();
    if (checkpoint.reason === 'limit') {
      checkpoint = { ...checkpoint, summary: o.text('loop.checkpointFallback', {steps}), steps };
      const request: LoopMessage = { role: 'user', content: 'The step or time limit was reached. Reply with {"final":"..."} summarizing verified progress, remaining work, and the next step.' };
      const timeout = AbortSignal.timeout(15000);
      try {
        const reply = await o.chat(trimHistory([...messages,request],budget), o.signal ? AbortSignal.any([timeout,o.signal]) : timeout);
        const summary = parseAction(reply)?.final ?? reply;
        checkpoint = { ...checkpoint, summary: summary.trim() || checkpoint.summary, steps };
      } catch { /* Keep the local fallback if the provider cannot summarize. */ }
    }
    if (o.signal?.aborted) return cancelled();
    if (!o.continueAfter || !await o.continueAfter(checkpoint)) {
      return o.signal?.aborted ? cancelled() : { final: checkpoint.summary, steps, stopped: checkpoint.reason };
    }
    if (checkpoint.reason === 'limit') messages.push({role:'assistant',content:checkpoint.summary},{role:'user',content:'Continue the original task from the prior results. Do not repeat completed work.'});
    messages.splice(0,messages.length,...trimHistory(messages,budget));
  }
}

/** Reads screenshots that Cude's own computer/browser tools saved (temp folders only) as data URLs. */
async function screenshotImages(observation: string): Promise<string[] | undefined> {
  const roots = [path.join(os.tmpdir(), 'cude-computer'), path.join(os.tmpdir(), 'cude-browser')].map(r => path.resolve(r).toLowerCase() + path.sep);
  const out: string[] = [];
  for (const file of extractImagePaths(observation).slice(0, 1)) {
    const full = path.resolve(file);
    if (!roots.some(r => full.toLowerCase().startsWith(r))) continue;
    try { const data = await fs.readFile(full); if (data.length <= 6 * 1024 * 1024) out.push(`data:image/png;base64,${data.toString('base64')}`); } catch { }
  }
  return out.length ? out : undefined;
}

function summarizeArgs(args: any) { if (!args || typeof args !== 'object') return ''; return Object.entries(args).map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v).slice(0, 80)}`).join(' · '); }

/** Keeps the system prompt, the task and the most recent turns within roughly 60k characters. */
export function trimHistory(messages: LoopMessage[], budget = 60000): LoopMessage[] {
  const head = messages.slice(0, 2); let tail = messages.slice(2);
  const size = (list: LoopMessage[]) => list.reduce((n, m) => n + m.content.length, 0);
  while (tail.length > 2 && size(head) + size(tail) > budget) tail = tail.slice(2);
  if (size(head) + size(tail) > budget) tail = tail.map(m => ({ ...m, content: clip(m.content, 8000) }));
  return [...head, ...tail];
}
