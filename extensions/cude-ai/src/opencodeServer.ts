// Persistent OpenCode server for Cude: one `opencode serve` process is started on demand and reused for every
// chat/agent step instead of launching the OpenCode CLI per message (which costs ~40 s and a few hundred MB each time).
// The server listens on 127.0.0.1 with a random password, runs with tools denied (Cude applies edits itself) and
// without OpenCode's own MCP servers/plugins, and is stopped when idle or when Cude closes.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type Invocation = { command: string; args: string[] };
export type OpencodeMessage = { role: string; content: string };

const IDLE_MS = 10 * 60_000;

/** OpenCode's own MCP server names from its global config, so they can be switched off for Cude's requests. */
export function opencodeMcpNames(home = os.homedir()): string[] {
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const file = path.join(home, '.config', 'opencode', name);
    try {
      const raw = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
      const mcp = JSON.parse(raw)?.mcp;
      if (mcp && typeof mcp === 'object') return Object.keys(mcp).filter(key => key !== 'cude-ide');
    } catch { }
  }
  return [];
}

/** "provider/model/with/slashes" → { providerID, modelID }. */
export function splitOpencodeModel(model: string): { providerID: string; modelID: string } | undefined {
  const i = model.indexOf('/');
  if (i <= 0 || i === model.length - 1) return undefined;
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

/** Readable reason from an OpenCode error object, or undefined. */
export function opencodeError(info: any): string | undefined {
  const err = info?.error ?? info?.info?.error;
  if (!err) return undefined;
  const msg = String(err?.data?.message ?? err?.message ?? err?.name ?? 'OpenCode error');
  return msg.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 400);
}

export class OpencodeServer {
  private child: ChildProcess | undefined;
  private url = '';
  private starting: Promise<string> | undefined;
  private readonly password = randomBytes(18).toString('base64url');
  private idle: NodeJS.Timeout | undefined;
  private inFlight = 0;
  /** True while a chat request is running (the memory guard must not stop the server then). */
  get busy() { return this.inFlight > 0; }

  constructor(private resolve: (args: string[]) => Invocation, private cwd: () => string) {}

  get running() { return !!this.child && this.child.exitCode === null && !!this.url; }

  private auth() { return 'Basic ' + Buffer.from(`opencode:${this.password}`).toString('base64'); }

  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (this.busy) { this.touch(); return; } this.stop(); }, IDLE_MS); this.idle.unref?.();
  }

  ensure(): Promise<string> {
    if (this.running) { this.touch(); return Promise.resolve(this.url); }
    if (this.starting) return this.starting;
    this.starting = new Promise<string>((resolve, reject) => {
      const mcp = Object.fromEntries(opencodeMcpNames().map(name => [name, { enabled: false }]));
      const env = { ...process.env, CI: '1', OPENCODE_SERVER_PASSWORD: this.password, OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { '*': 'deny' }, mcp }) };
      const inv = this.resolve(['serve', '--pure', '--port', '0', '--hostname', '127.0.0.1']);
      let child: ChildProcess;
      try { child = spawn(inv.command, inv.args, { cwd: this.cwd(), env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { this.starting = undefined; reject(error); return; }
      this.child = child;
      let log = '';
      const timer = setTimeout(() => { fail(new Error('OpenCode server did not start within 90 seconds.')); }, 90_000);
      timer.unref?.();
      const fail = (error: Error) => { clearTimeout(timer); this.starting = undefined; this.stop(); reject(error); };
      const onData = (d: Buffer) => {
        log = (log + d.toString('utf8')).slice(-4000);
        const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(log);
        if (m && !this.url) { clearTimeout(timer); this.url = m[1]; this.starting = undefined; this.touch(); resolve(this.url); }
      };
      child.stdout?.on('data', onData); child.stderr?.on('data', onData);
      child.on('error', error => fail(error));
      child.on('exit', code => {
        const safeLog = log.split(this.password).join('[redacted]').trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300);
        if (!this.url) fail(new Error(`OpenCode server exited (${code}). ${safeLog}`));
        this.url = ''; this.child = undefined;
      });
    });
    return this.starting;
  }

  /** Sends the conversation as one prompt in a fresh session and returns the reply text. */
  async chat(model: string, messages: OpencodeMessage[], signal?: AbortSignal): Promise<string> {
    const target = splitOpencodeModel(model);
    if (!target) throw new Error(`Choose an OpenCode model such as provider/model (got "${model}").`);
    const base = await this.ensure();
    this.inFlight++;
    try {
    const headers = { 'content-type': 'application/json', authorization: this.auth() };
    const sessionRes = await fetch(`${base}/session`, { method: 'POST', headers, body: JSON.stringify({ title: 'Cude' }), signal });
    const session = await sessionRes.json().catch(() => undefined) as any;
    if (!sessionRes.ok || !session?.id) throw new Error(sessionRes.ok ? 'OpenCode did not create a session.' : `OpenCode ${sessionRes.status}: ${opencodeError(session) || 'session creation failed'}`);
    const sid = encodeURIComponent(String(session.id));
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const text = messages.filter(m => m.role !== 'system').map(m => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n');
    const abort = () => { void fetch(`${base}/session/${sid}/abort`, { method: 'POST', headers }).catch(() => undefined); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(`${base}/session/${sid}/message`, { method: 'POST', headers, signal,
        body: JSON.stringify({ model: target, agent: 'plan', tools: {}, ...(system ? { system } : {}), parts: [{ type: 'text', text }] }) });
      const body = await response.json().catch(() => undefined) as any;
      if (!response.ok) throw new Error(`OpenCode ${response.status}: ${opencodeError(body) || JSON.stringify(body ?? {}).slice(0, 200)}`);
      const failure = opencodeError(body?.info);
      const reply = (body?.parts || []).filter((p: any) => p?.type === 'text').map((p: any) => String(p.text || '')).join('').trim();
      if (!reply && failure) throw new Error(failure);
      if (!reply) throw new Error('OpenCode returned an empty reply.');
      return reply;
    } finally {
      signal?.removeEventListener('abort', abort);
      void fetch(`${base}/session/${sid}`, { method: 'DELETE', headers }).catch(() => undefined);
      this.touch();
    }
    } finally { this.inFlight = Math.max(0, this.inFlight - 1); }
  }

  stop() {
    if (this.idle) { clearTimeout(this.idle); this.idle = undefined; }
    const child = this.child; this.child = undefined; this.url = '';
    if (!child?.pid || !Number.isInteger(child.pid) || child.pid <= 0) return;
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', () => { try { child.kill(); } catch { } });
        killer.unref();
      } else child.kill();
    } catch { }
  }
}
