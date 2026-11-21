// Isolated browser control for Cude AI: Chrome or Edge with its own profile (%LOCALAPPDATA%\Cude\browser-profile),
// driven over the Chrome DevTools Protocol. The user's own browser profile, passwords and cookies are never used.
// Clicks, typing, opening pages and form submission are approved in Cude; login and payment pages always ask again;
// passwords and card details are never typed. No vscode dependency (unit tested); appBridge.ts wires the UI.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Socket } from 'node:net';
import { looksLikeCardNumber, type Approver } from './computerUse';

export type BrowserSettings = { enabled: boolean };
export type BrowserOptions = {
  approver: Approver; settings: () => BrowserSettings; language?: () => 'tr' | 'en';
  profileDir?: string; executable?: string; shotDir?: string;
  onLaunch?: (pid: number | undefined) => void; onClose?: (pid: number | undefined) => void;
  /** Test hook: replaces the CDP transport. */
  connect?: (wsUrl: string) => Promise<CdpConnection>;
  fetchJson?: (url: string, method?: string) => Promise<any>;
};

// ---------- Profile isolation (pure, unit tested) ----------
export function defaultProfileDir(env: NodeJS.ProcessEnv = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Cude', 'browser-profile');
}
/** The user's real browser data folders. Cude must never point a browser at (or inside) any of these. */
export function userProfileRoots(env: NodeJS.ProcessEnv = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return [
    path.join(local, 'Google', 'Chrome'), path.join(local, 'Google', 'Chrome Beta'), path.join(local, 'Google', 'Chrome SxS'),
    path.join(local, 'Microsoft', 'Edge'), path.join(local, 'Microsoft', 'Edge Beta'), path.join(local, 'Microsoft', 'Edge Dev'),
    path.join(local, 'BraveSoftware'), path.join(local, 'Vivaldi'), path.join(local, 'Chromium'), path.join(local, 'Yandex'),
    path.join(roaming, 'Opera Software'), path.join(roaming, 'Mozilla'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Google'), path.join(os.homedir(), '.config', 'google-chrome'),
  ];
}
export function isIsolatedProfile(dir: string, env: NodeJS.ProcessEnv = process.env) {
  const full = path.resolve(dir).toLowerCase();
  if (!full || full === path.resolve(os.homedir()).toLowerCase()) return false;
  for (const root of userProfileRoots(env)) {
    const r = path.resolve(root).toLowerCase();
    if (full === r || full.startsWith(r + path.sep) || r.startsWith(full + path.sep)) return false;
  }
  return /[\\/]cude[\\/]/i.test(full + path.sep);
}

export function browserCandidates(env: NodeJS.ProcessEnv = process.env) {
  const pf = env.ProgramFiles || 'C:\\Program Files', pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  if (process.platform !== 'win32') return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
}

/** Only web pages: http(s) and about:blank. Blocks file:, javascript:, data:, chrome: and similar. */
export function safeUrl(raw: string): URL | undefined {
  let text = String(raw || '').trim();
  if (!text) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (url.href === 'about:blank') return url;
    if (!/^https?:$/.test(url.protocol)) return undefined;
    if (url.username || url.password) return undefined;
    return url;
  } catch { return undefined; }
}

export type PageElement = { ref: string; tag: string; type: string; label: string; href?: string; sensitive?: boolean; submit?: boolean };
export type PageKind = 'normal' | 'login' | 'payment';
export const SENSITIVE_FIELD = /pass(?:word|wd)?|parola|şifre|sifre|\bpin\b|cvv|cvc|csc|card.?(?:number|no|num)|cc-?(?:num|number|csc|exp)|kart|iban|otp|one.?time|security.?code|ssn|tckn|kimlik/i;

/** Decides whether a field must never receive text. */
export function fieldRefusal(field: { type?: string; autocomplete?: string; name?: string; label?: string; sensitive?: boolean }, text: string): 'password' | 'card' | undefined {
  const type = String(field.type || '').toLowerCase();
  if (type === 'password' || field.sensitive) return 'password';
  if (/(?:^|\s)(?:cc-|current-password|new-password|one-time-code)/i.test(String(field.autocomplete || ''))) return 'password';
  if (SENSITIVE_FIELD.test(`${field.name || ''} ${field.label || ''}`)) return 'password';
  if (looksLikeCardNumber(text)) return 'card';
  return undefined;
}

// Runs inside the page. Marks interactive elements with data-cude-ref and describes the page.
const READ_SCRIPT = String.raw`(() => {
  const SENS = /pass(?:word|wd)?|parola|şifre|sifre|\bpin\b|cvv|cvc|csc|card.?(?:number|no|num)|cc-?(?:num|number|csc|exp)|kart|iban|otp|one.?time|security.?code|ssn|tckn|kimlik/i;
  const vis = el => { const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const label = el => clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.placeholder || el.title || el.alt || (el.type !== 'password' && el.tagName !== 'INPUT' ? el.innerText : '') || (el.type === 'submit' || el.type === 'button' ? el.value : '') || el.name || el.id || '').slice(0, 80);
  const sensitive = el => el.type === 'password' || /(?:^|\s)(?:cc-|current-password|new-password|one-time-code)/i.test(el.autocomplete || '') || ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) && SENS.test((el.name || '') + ' ' + (el.id || '') + ' ' + label(el)));
  document.querySelectorAll('[data-cude-ref]').forEach(e => e.removeAttribute('data-cude-ref'));
  const out = []; let n = 0;
  for (const el of document.querySelectorAll('a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=option],[contenteditable=""],[contenteditable=true]')) {
    if (n >= 150) break;
    if (el.type === 'hidden' || el.disabled || !vis(el)) continue;
    const ref = 'r' + (++n); el.setAttribute('data-cude-ref', ref);
    const submit = (el.tagName === 'BUTTON' && (el.type || 'submit') === 'submit' && !!el.form) || (el.tagName === 'INPUT' && /^(submit|image)$/i.test(el.type));
    out.push({ ref, tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || el.getAttribute('role') || '').toLowerCase(), label: label(el), href: el.href ? String(el.href).slice(0, 140) : '', sensitive: sensitive(el), submit });
  }
  const hasPassword = !!document.querySelector('input[type=password]');
  const hasCard = !!document.querySelector('input[autocomplete^="cc-"]') || out.some(e => e.sensitive && /card|kart|cvv|cvc|cc-/i.test(e.label));
  const kind = hasCard || /checkout|payment|ödeme|odeme|\/pay\b|billing/i.test(location.href) ? 'payment' : hasPassword || /login|signin|sign-in|giris|oturum/i.test(location.href) ? 'login' : 'normal';
  const text = clean(document.body ? document.body.innerText : '').slice(0, 9000);
  return { title: document.title, url: location.href, kind, text, elements: out };
})()`;

const INFO_SCRIPT = (ref: string) => String.raw`(() => {
  const el = document.querySelector('[data-cude-ref="${ref.replace(/[^\w-]/g, '')}"]');
  if (!el) return { exists: false };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const SENS = /pass(?:word|wd)?|parola|şifre|sifre|\bpin\b|cvv|cvc|csc|card.?(?:number|no|num)|cc-?(?:num|number|csc|exp)|kart|iban|otp|one.?time|security.?code|ssn|tckn|kimlik/i;
  const label = String(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.placeholder || el.innerText || el.value && el.type !== 'password' && el.value || el.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const submit = (el.tagName === 'BUTTON' && (el.type || 'submit') === 'submit' && !!el.form) || (el.tagName === 'INPUT' && /^(submit|image)$/i.test(el.type));
  const risky = /\b(pay|buy|purchase|order|checkout|subscribe|confirm|delete|sign in|log in|login|send|submit)\b|satın|öde|sipariş|onayla|gönder|giriş|sil\b|abone/i.test(label);
  const hasPassword = !!document.querySelector('input[type=password]');
  const hasCard = !!document.querySelector('input[autocomplete^="cc-"]');
  const kind = hasCard || /checkout|payment|ödeme|odeme|\/pay\b|billing/i.test(location.href) ? 'payment' : hasPassword || /login|signin|sign-in|giris|oturum/i.test(location.href) ? 'login' : 'normal';
  return { exists: true, tag: el.tagName.toLowerCase(), type: String(el.getAttribute('type') || '').toLowerCase(), autocomplete: el.autocomplete || '', name: (el.name || '') + ' ' + (el.id || ''), label,
    sensitive: el.type === 'password' || /(?:^|\s)(?:cc-|current-password|new-password|one-time-code)/i.test(el.autocomplete || '') || ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) && SENS.test((el.name || '') + ' ' + (el.id || '') + ' ' + label)),
    editable: el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|file|image|range|color)$/i.test(el.type)),
    inForm: !!el.form || !!el.closest('form'), submit, risky, kind, x: r.left + r.width / 2, y: r.top + r.height / 2, host: location.host };
})()`;

// ---------- Minimal CDP WebSocket client (no Origin header, localhost only) ----------
export interface CdpConnection { send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<any>; close(): void; readonly closed: boolean }

class CdpSocket implements CdpConnection {
  private seq = 0; private buffer = Buffer.alloc(0); private parts: Buffer[] = [];
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  closed = false;
  private constructor(private socket: Socket) {
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.drain(); });
    socket.on('close', () => this.fail('CDP connection closed'));
    socket.on('error', error => this.fail(`CDP error: ${error.message}`));
  }
  static connect(wsUrl: string, timeoutMs = 8000): Promise<CdpSocket> {
    const url = new URL(wsUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return Promise.reject(new Error('CDP must be local'));
    return new Promise((resolve, reject) => {
      const req = http.request({ host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port, path: url.pathname + url.search, timeout: timeoutMs,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64') } });
      req.on('upgrade', (_res, socket, head) => { const s = new CdpSocket(socket as Socket); if (head?.length) { s.buffer = Buffer.from(head); s.drain(); } resolve(s); });
      req.on('response', res => reject(new Error(`CDP upgrade refused (HTTP ${res.statusCode})`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('CDP connect timeout')); });
      req.on('error', reject);
      req.end();
    });
  }
  private fail(why: string) {
    if (this.closed) return; this.closed = true;
    for (const [id, w] of this.waiting) { clearTimeout(w.timer); w.reject(new Error(why)); this.waiting.delete(id); }
  }
  private frame(opcode: number, payload: Buffer) {
    const mask = randomBytes(4); const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len]) : len < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
    const body = Buffer.alloc(len); for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
    try { this.socket.write(Buffer.concat([head, mask, body])); }
    catch (err: any) { this.fail(`CDP write error: ${err?.message || err}`); }
  }
  private drain() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0], b1 = this.buffer[1]; let len = b1 & 127, offset = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; len = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      const masked = (b1 & 0x80) !== 0; const maskKey = masked ? this.buffer.subarray(offset, offset + 4) : undefined; if (masked) offset += 4;
      if (this.buffer.length < offset + len) return;
      let payload = this.buffer.subarray(offset, offset + len);
      if (maskKey) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3]; }
      this.buffer = this.buffer.subarray(offset + len);
      const opcode = b0 & 15, fin = (b0 & 0x80) !== 0;
      if (opcode === 8) { this.close(); return; }
      if (opcode === 9) { this.frame(10, Buffer.from(payload)); continue; }
      if (opcode === 1 || opcode === 0) {
        this.parts.push(Buffer.from(payload));
        if (!fin) continue;
        const text = Buffer.concat(this.parts).toString('utf8'); this.parts = [];
        try {
          const msg = JSON.parse(text);
          const w = msg.id !== undefined ? this.waiting.get(msg.id) : undefined;
          if (w) { this.waiting.delete(msg.id); clearTimeout(w.timer); if (msg.error) w.reject(new Error(String(msg.error.message || 'CDP error'))); else w.resolve(msg.result); }
        } catch { }
      }
    }
  }
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 20000) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = ++this.seq;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`CDP timeout (${method})`)); }, timeoutMs);
      timer.unref?.();
      this.waiting.set(id, { resolve, reject, timer });
      this.frame(1, Buffer.from(JSON.stringify({ id, method, params })));
    });
  }
  close() { if (this.closed) return; try { this.frame(8, Buffer.alloc(0)); } catch { } try { this.socket.end(); this.socket.destroy(); } catch { } this.fail('closed'); }
}

function httpJson(url: string, method = 'GET'): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, timeout: 5000 }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', c => { body += c; if (body.length > 2_000_000) req.destroy(); });
      res.on('end', () => { if ((res.statusCode || 500) >= 400) return reject(new Error(`HTTP ${res.statusCode}`)); try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({ text: body }); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject); req.end();
  });
}

const T = {
  tr: {
    disabled: 'Tarayıcı kontrolü kapalı. Kullanıcı "Ajanlar ve uygulamalar" bölümünden açabilir.',
    noBrowser: 'Chrome ya da Microsoft Edge bulunamadı. Birini kurun; Cude kendi ayrı profilini kullanır.',
    notRunning: 'Cude tarayıcısı açık değil. Önce browser_open ile bir sayfa açın.',
    badUrl: 'Yalnız http(s) adresleri açılabilir (file:, javascript:, data: ve tarayıcı iç sayfaları açılmaz).',
    declined: 'Kullanıcı bu eylemi onaylamadı.',
    noRef: 'Bu ref sayfada yok. browser_read ile öğeleri yeniden listeleyin.',
    password: 'Bu bir parola, kart ya da gizli bilgi alanı; Cude parola ve kart bilgisi yazmaz. Kullanıcıdan bu alanı kendisinin doldurmasını isteyin.',
    card: 'Metin bir kart numarasına benziyor; Cude kart bilgisi yazmaz.',
    notEditable: 'Bu öğe yazı alanı değil.',
    profile: 'Güvenlik: tarayıcı profili kullanıcının kendi profilini gösteriyor; Cude yalnız kendi izole profilini kullanır.',
  },
  en: {
    disabled: 'Browser control is turned off. The user can turn it on in "Agents and apps".',
    noBrowser: 'Chrome or Microsoft Edge was not found. Install one; Cude uses its own separate profile.',
    notRunning: 'The Cude browser is not open. Open a page with browser_open first.',
    badUrl: 'Only http(s) addresses can be opened (no file:, javascript:, data: or browser-internal pages).',
    declined: 'The user declined this action.',
    noRef: 'That ref is not on the page. Run browser_read again.',
    password: 'This is a password, card or secret field; Cude never types passwords or card details. Ask the user to fill it in themselves.',
    card: 'The text looks like a card number; Cude never types card details.',
    notEditable: 'That element is not a text field.',
    profile: 'Safety: the browser profile points at the user\'s own profile; Cude only uses its isolated profile.',
  },
};

export class CudeBrowser {
  private pid: number | undefined;
  private port: number | undefined;
  private tabId: string | undefined;
  private conn: CdpConnection | undefined;
  private grants = new Set<string>();

  constructor(private o: BrowserOptions) {}
  private get lang(): 'tr' | 'en' { return this.o.language?.() ?? 'en'; }
  private t(key: keyof typeof T.en) { return T[this.lang][key]; }
  get profileDir() { return this.o.profileDir ?? defaultProfileDir(); }
  get browserPid() { return this.pid; }
  get running() { return !!this.port; }
  clearGrants() { this.grants.clear(); }

  private fetchJson(url: string, method?: string) { return (this.o.fetchJson ?? httpJson)(url, method); }
  private executable() {
    if (this.o.executable) return this.o.executable;
    const env = process.env.CUDE_BROWSER_PATH;
    if (env && fs.existsSync(env)) return env;
    return browserCandidates().find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  }

  /** Port of an already running isolated instance, read from its own profile's DevToolsActivePort. */
  private async livePort(): Promise<number | undefined> {
    try {
      const port = Number(fs.readFileSync(path.join(this.profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
      await this.fetchJson(`http://127.0.0.1:${port}/json/version`);
      return port;
    } catch { return undefined; }
  }

  private async ensureRunning(): Promise<number> {
    if (this.port) { try { await this.fetchJson(`http://127.0.0.1:${this.port}/json/version`); return this.port; } catch { this.port = undefined; this.conn?.close(); this.conn = undefined; } }
    if (!isIsolatedProfile(this.profileDir)) throw new Error('PROFILE_NOT_ISOLATED');
    const live = await this.livePort();
    if (live) { this.port = live; return live; }
    const exe = this.executable();
    if (!exe) throw new Error('NO_BROWSER');
    fs.mkdirSync(this.profileDir, { recursive: true });
    try { fs.unlinkSync(path.join(this.profileDir, 'DevToolsActivePort')); } catch { }
    const args = [`--user-data-dir=${this.profileDir}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
      '--disable-sync', '--disable-features=PasswordManagerOnboarding,AutofillServerCommunication', '--password-store=basic', '--new-window', 'about:blank'];
    let spawnError: Error | undefined;
    const child = spawn(exe, args, { detached: true, shell: false, stdio: 'ignore', windowsHide: false });
    child.on('error', err => { spawnError = err; });
    child.unref();
    this.pid = child.pid;
    for (let i = 0; i < 100; i++) {
      if (spawnError) { this.pid = undefined; throw spawnError; }
      await new Promise(r => setTimeout(r, 150));
      if (spawnError) { this.pid = undefined; throw spawnError; }
      const port = await this.livePort();
      if (port) { this.port = port; this.o.onLaunch?.(this.pid); return port; }
    }
    try { child.kill(); } catch { }
    this.pid = undefined;
    throw new Error('BROWSER_START_TIMEOUT');
  }

  private async pages(): Promise<Array<{ id: string; title: string; url: string; webSocketDebuggerUrl?: string; type: string }>> {
    if (!this.port) return [];
    const list = await this.fetchJson(`http://127.0.0.1:${this.port}/json/list`);
    return (Array.isArray(list) ? list : []).filter((p: any) => p.type === 'page');
  }

  private async page(): Promise<CdpConnection> {
    await this.ensureRunning();
    if (this.conn && !this.conn.closed) return this.conn;
    let pages = await this.pages();
    let target = pages.find(p => p.id === this.tabId) ?? pages[0];
    if (!target) { target = await this.fetchJson(`http://127.0.0.1:${this.port}/json/new?about:blank`, 'PUT'); pages = [target!]; }
    if (!target?.webSocketDebuggerUrl) throw new Error('NO_TAB');
    this.tabId = target.id;
    this.conn = await (this.o.connect ?? CdpSocket.connect)(target.webSocketDebuggerUrl);
    return this.conn;
  }

  private async evaluate<T = any>(expression: string): Promise<T> {
    const conn = await this.page();
    const r = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) throw new Error(`page script failed: ${String(r.exceptionDetails.text || '').slice(0, 200)}`);
    return r?.result?.value as T;
  }
  private async waitLoad(timeoutMs = 15000) {
    const end = Date.now() + timeoutMs;
    await new Promise(r => setTimeout(r, 300));
    while (Date.now() < end) {
      try { if (await this.evaluate<string>('document.readyState') === 'complete') return; } catch { }
      await new Promise(r => setTimeout(r, 250));
    }
  }

  private async approve(key: string, title: string, detail: string, sessionable: boolean, kind: string) {
    if (sessionable && this.grants.has(key)) return true;
    const answer = await this.o.approver({ title, detail, app: key, sessionable, kind });
    if (answer === 'deny') return false;
    if (answer === 'session' && sessionable) this.grants.add(key);
    return true;
  }

  private async guard(run: () => Promise<string>) {
    if (!this.o.settings().enabled) return this.t('disabled');
    try { return await run(); }
    catch (error: any) {
      const code = String(error?.message || error);
      if (code === 'NO_BROWSER') return this.t('noBrowser');
      if (code === 'PROFILE_NOT_ISOLATED') return this.t('profile');
      if (code === 'NOT_RUNNING') return this.t('notRunning');
      if (/ECONNREFUSED|CDP connection closed/.test(code)) { this.port = undefined; this.conn = undefined; return this.t('notRunning'); }
      return `Browser error: ${code.slice(0, 300)}`;
    }
  }

  open(args: { url?: string; new_tab?: boolean }) {
    return this.guard(async () => {
      const tr = this.lang === 'tr';
      const url = safeUrl(String(args.url || ''));
      if (!url) return this.t('badUrl');
      const host = url.host || 'about:blank';
      if (!await this.approve(`open:${host}`, tr ? `Cude tarayıcısında ${host} açılsın mı?` : `Open ${host} in the Cude browser?`,
        `${url.href}\n${tr ? 'Ayrı Cude profili kullanılır; kendi tarayıcınıza, parolalarınıza ve çerezlerinize dokunulmaz.' : 'Uses the separate Cude profile; your own browser, passwords and cookies are not touched.'}`, true, 'open')) return this.t('declined');
      await this.ensureRunning();
      if (args.new_tab) {
        const tab = await this.fetchJson(`http://127.0.0.1:${this.port}/json/new?${encodeURI(url.href)}`, 'PUT');
        this.conn?.close(); this.conn = undefined; this.tabId = tab?.id;
      } else {
        const conn = await this.page();
        await conn.send('Page.navigate', { url: url.href });
      }
      await this.waitLoad();
      const info = await this.evaluate<{ title: string; url: string }>('({title: document.title, url: location.href})');
      return `Opened ${info?.url || url.href}\nTitle: ${info?.title || '(none)'}\nUse browser_read to see the text and clickable elements.`;
    });
  }

  read(_args: Record<string, unknown> = {}) {
    return this.guard(async () => {
      if (!this.port && !await this.livePort()) return this.t('notRunning');
      const page = await this.evaluate<{ title: string; url: string; kind: PageKind; text: string; elements: PageElement[] }>(READ_SCRIPT);
      const rows = (page.elements || []).map(e => `${e.ref} ${e.tag}${e.type ? `[${e.type}]` : ''} "${e.label}"${e.href ? ` → ${e.href}` : ''}${e.sensitive ? ' [secret field: never typed]' : ''}${e.submit ? ' [submits form]' : ''}`);
      const warn = page.kind === 'login' ? '\nThis is a sign-in page: every click asks the user; passwords are never typed.' : page.kind === 'payment' ? '\nThis is a payment page: every click asks the user; card details are never typed.' : '';
      return `Title: ${page.title}\nURL: ${page.url}${warn}\n\nInteractive elements (use the ref):\n${rows.join('\n') || '(none)'}\n\nPage text:\n${page.text}`;
    });
  }

  private async info(ref: string) {
    return this.evaluate<any>(INFO_SCRIPT(ref));
  }

  click(args: { ref?: string }) {
    return this.guard(async () => {
      const tr = this.lang === 'tr';
      if (!this.port && !await this.livePort()) return this.t('notRunning');
      const ref = String(args.ref || '');
      const el = await this.info(ref);
      if (!el?.exists) return this.t('noRef');
      // Form submission, sign-in and payment pages, and risky buttons (buy, delete, send...) always ask, never "for this session".
      const always = el.submit || el.risky || el.kind !== 'normal';
      const why = el.submit ? (tr ? 'Bu tıklama bir formu gönderir.' : 'This click submits a form.') : el.kind === 'payment' ? (tr ? 'Ödeme sayfası.' : 'Payment page.') : el.kind === 'login' ? (tr ? 'Giriş sayfası.' : 'Sign-in page.') : el.risky ? (tr ? 'Bu düğme geri alınamayan bir işlem yapabilir.' : 'This button may do something irreversible.') : '';
      if (!await this.approve(`site:${el.host}`, tr ? `Cude "${el.label || el.tag}" öğesine tıklasın mı?` : `Let Cude click "${el.label || el.tag}"?`, `${el.host}${why ? `\n${why}` : ''}`, !always, el.submit ? 'submit' : 'click')) return this.t('declined');
      const conn = await this.page();
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await conn.send('Input.dispatchMouseEvent', { type, x: el.x, y: el.y, button: 'left', clickCount: 1 });
      await this.waitLoad(8000);
      const after = await this.evaluate<{ title: string; url: string }>('({title: document.title, url: location.href})');
      return `Clicked ${ref} "${el.label}". Now at: ${after?.title || ''} ${after?.url || ''}`;
    });
  }

  type(args: { ref?: string; text?: string; submit?: boolean }) {
    return this.guard(async () => {
      const tr = this.lang === 'tr';
      if (!this.port && !await this.livePort()) return this.t('notRunning');
      const ref = String(args.ref || ''), text = String(args.text ?? '');
      if (text.length > 4000) return tr ? 'Metin en fazla 4000 karakter olabilir.' : 'Text must be at most 4000 characters.';
      const el = await this.info(ref);
      if (!el?.exists) return this.t('noRef');
      if (!el.editable) return this.t('notEditable');
      const refusal = fieldRefusal(el, text);
      if (refusal) return this.t(refusal);
      const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      const always = !!args.submit || el.kind !== 'normal';
      if (!await this.approve(`site:${el.host}`, tr ? `Cude "${el.label || 'alan'}" alanına yazsın mı?` : `Let Cude type into "${el.label || 'field'}"?`,
        `${el.host}\n${tr ? 'Metin' : 'Text'}: "${preview}"${args.submit ? `\n${tr ? 'Ardından Enter ile form gönderilir.' : 'Then Enter submits the form.'}` : ''}`, !always, args.submit ? 'submit' : 'type')) return this.t('declined');
      await this.evaluate(String.raw`(() => { const el = document.querySelector('[data-cude-ref="${ref.replace(/[^\w-]/g, '')}"]'); if (!el) return false; el.focus(); if (el.select) el.select(); else if (el.isContentEditable) document.execCommand('selectAll'); return true; })()`);
      const conn = await this.page();
      await conn.send('Input.insertText', { text });
      if (args.submit) {
        for (const type of ['keyDown', 'keyUp']) await conn.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
        await this.waitLoad(8000);
      }
      return `Typed ${text.length} characters into ${ref} "${el.label}"${args.submit ? ' and pressed Enter' : ''}.`;
    });
  }

  screenshot(_args: Record<string, unknown> = {}) {
    return this.guard(async () => {
      if (!this.port && !await this.livePort()) return this.t('notRunning');
      const conn = await this.page();
      const shot = await conn.send('Page.captureScreenshot', { format: 'png' }, 30000);
      const dir = this.o.shotDir ?? path.join(os.tmpdir(), 'cude-browser');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `page-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      fs.writeFileSync(file, Buffer.from(String(shot?.data || ''), 'base64'));
      const info = await this.evaluate<{ title: string; url: string }>('({title: document.title, url: location.href})');
      return `Page screenshot saved: ${file}\n[image: ${file}]\n${info?.title || ''} ${info?.url || ''}`;
    });
  }

  tabs(args: { activate?: string } = {}) {
    return this.guard(async () => {
      if (!this.port && !(this.port = await this.livePort())) return this.t('notRunning');
      if (args.activate) {
        const id = String(args.activate).replace(/[^\w-]/g, '');
        await this.fetchJson(`http://127.0.0.1:${this.port}/json/activate/${id}`);
        this.conn?.close(); this.conn = undefined; this.tabId = id;
      }
      const pages = await this.pages();
      return pages.length ? pages.map(p => `${p.id === this.tabId ? '*' : ' '} ${p.id} | ${p.title.slice(0, 80)} | ${p.url.slice(0, 120)}`).join('\n') : '(no tabs)';
    });
  }

  private killPid(pid: number | undefined) {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return;
    try { process.kill(pid); } catch { }
  }

  close(args: { force?: boolean } = {}) {
    const run = async () => {
      const pid = this.pid;
      if (!this.port && !(this.port = await this.livePort())) {
        if (pid) { this.killPid(pid); this.o.onClose?.(pid); this.pid = undefined; }
        this.conn?.close(); this.conn = undefined; this.tabId = undefined; this.grants.clear();
        return this.t('notRunning');
      }
      let closedViaCdp = false;
      try {
        const version = await this.fetchJson(`http://127.0.0.1:${this.port}/json/version`);
        if (version?.webSocketDebuggerUrl) { const b = await (this.o.connect ?? CdpSocket.connect)(version.webSocketDebuggerUrl); await b.send('Browser.close').then(() => { closedViaCdp = true; }).catch(() => { }); b.close(); }
      } catch { }
      if (!closedViaCdp && pid) this.killPid(pid);
      this.conn?.close(); this.conn = undefined; this.port = undefined; this.tabId = undefined;
      this.o.onClose?.(pid); this.pid = undefined; this.grants.clear();
      return this.lang === 'tr' ? 'Cude tarayıcısı kapatıldı.' : 'The Cude browser was closed.';
    };
    return args?.force ? run().catch(e => `Browser error: ${String(e?.message || e).slice(0, 300)}`) : this.guard(run);
  }

  dispose() {
    const pid = this.pid;
    this.conn?.close(); this.conn = undefined;
    this.port = undefined; this.tabId = undefined; this.pid = undefined;
    this.grants.clear();
    if (pid) { this.killPid(pid); this.o.onClose?.(pid); }
  }
}
