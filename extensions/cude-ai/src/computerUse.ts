// Computer use for Cude AI (Windows first): see windows, read UI elements, click, type, press keys and scroll.
// Safety model: every action is approved in Cude (optionally "for this session" per app); password fields,
// elevated (administrator) windows, the lock screen, password managers, the user's own browsers and Cude itself
// are never touched; a visible "Cude is using the screen" bar with a Stop button (and Esc) ends the session at once.
// This module has no vscode dependency so the policy can be unit tested; appBridge.ts wires the UI.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type Approval = 'once' | 'session' | 'deny';
export type ApprovalRequest = { title: string; detail: string; app: string; sessionable: boolean; kind: string };
export type Approver = (request: ApprovalRequest) => Promise<Approval>;
export type ActionKind = 'capture' | 'read' | 'focus' | 'click' | 'type' | 'keys' | 'scroll' | 'open';

export type WindowInfo = {
  id: number; title: string; process: string; pid: number; x: number; y: number; width: number; height: number;
  minimized?: boolean; elevated?: boolean | 'denied'; foreground?: boolean; owner?: number;
};
export type TargetInfo = WindowInfo & { locked?: boolean; password?: boolean; elementName?: string; pointX?: number; pointY?: number; hasPoint?: boolean };
export type UiElement = { id: string; type: string; name: string; automationId?: string; x: number; y: number; width: number; height: number; enabled?: boolean; password?: boolean; focused?: boolean; value?: string };

/** Talks to the native side. The Windows implementation is a persistent PowerShell + C# helper. */
export interface ComputerDriver {
  call<T = any>(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  dispose(): void;
}
/** The visible "Cude is using the screen" bar. */
export interface ActivityBar { show(label: string): void; hide(): void; dispose(): void }
export interface ComputerUi { active?(label: string): void; idle?(): void; stopped?(): void }

export type ComputerSettings = { enabled: boolean; allowedApps: string[] };
export type ComputerOptions = {
  driver: ComputerDriver; approver: Approver; settings: () => ComputerSettings;
  bar?: ActivityBar; ui?: ComputerUi; language?: () => 'tr' | 'en';
  selfProcesses?: string[]; shotDir?: string; now?: () => number;
  /** Brings Cude's own window forward so the approval dialog is visible. */
  revealIde?: () => Promise<void>;
};

// ---------- Policy (pure, unit tested) ----------
export const PROTECTED_PROCESSES = ['logonui', 'lockapp', 'consent', 'credentialuibroker', 'securityhealthui', 'sechealthui', 'winlogon',
  'keepass', 'keepassxc', '1password', 'bitwarden', 'lastpass', 'dashlane', 'nordpass', 'enpass', 'roboform', 'protonpass', 'taskmgr', 'regedit', 'mmc', 'useraccountcontrolsettings'];
export const USER_BROWSERS = ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'iexplore', 'arc', 'waterfox', 'librewolf', 'chromium', 'yandex', 'browser'];
export const SENSITIVE_NAME = /pass(?:word|wd|code)?\b|parola|şifre|sifre|\bpin\b|cvv|cvc|csc\b|card.?(?:number|no|num)|cc-?(?:num|number|csc|exp)|kart.?(?:no|numara)?|iban|one.?time|\botp\b|security.?code|güvenlik kodu|\bssn\b|\btckn\b|kimlik|api.?key|private.?key|access.?token|\bsecret\b/i;

export type TargetRules = { selfProcesses: string[]; protectedPids?: number[]; browserPids: Set<number> | number[]; allowedApps: string[] };
export type Refusal = 'locked' | 'elevated' | 'self' | 'protected' | 'user-browser' | 'not-allowed' | 'unknown' | 'password' | 'card';

/** Returns why a window must not be touched, or undefined when it may be used (after approval). */
export function targetRefusal(t: Partial<TargetInfo> | undefined, rules: TargetRules): Refusal | undefined {
  if (!t) return 'unknown';
  if (t.locked) return 'locked';
  const name = String(t.process || '').toLowerCase().replace(/\.exe$/, '');
  if (!name) return 'unknown';
  if (t.elevated === true || t.elevated === 'denied') return 'elevated';
  if (rules.selfProcesses.map(s => s.toLowerCase()).includes(name) || rules.protectedPids?.includes(Number(t.pid))) return 'self';
  if (PROTECTED_PROCESSES.includes(name)) return 'protected';
  const browserPids = rules.browserPids instanceof Set ? rules.browserPids : new Set(rules.browserPids);
  const cudeBrowser = browserPids.has(Number(t.pid));
  if (USER_BROWSERS.includes(name) && !cudeBrowser) return 'user-browser';
  const allowed = rules.allowedApps.map(a => a.toLowerCase().replace(/\.exe$/, '')).filter(Boolean);
  if (allowed.length && !allowed.includes(name) && !cudeBrowser) return 'not-allowed';
  return undefined;
}

/** True for 13-19 digit numbers that pass the Luhn check (payment cards). */
export function looksLikeCardNumber(text: string): boolean {
  for (const match of String(text).matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/** Refuses text that must never be typed (card numbers) and fields that must never receive text. */
export function typingRefusal(text: string, field?: { password?: boolean; name?: string }): Refusal | undefined {
  if (field?.password) return 'password';
  if (field?.name && SENSITIVE_NAME.test(field.name)) return 'password';
  if (looksLikeCardNumber(text)) return 'card';
  return undefined;
}

const VK: Record<string, number> = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, meta: 0x5b, cmd: 0x5b, windows: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20, backspace: 0x08, delete: 0x2e, del: 0x2e,
  insert: 0x2d, ins: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, printscreen: 0x2c, menu: 0x5d, apps: 0x5d,
  plus: 0xbb, minus: 0xbd, comma: 0xbc, period: 0xbe, dot: 0xbe,
};
const MODIFIERS = new Set([0x11, 0x10, 0x12, 0x5b]);

/** Parses "ctrl+s", "alt+f4, enter" into virtual-key combos. Throws on unknown keys or forbidden combos. */
export function parseKeys(input: string | string[]): number[][] {
  const combos = (Array.isArray(input) ? input : String(input || '').split(/[,;]/)).map(s => String(s).trim()).filter(Boolean);
  if (!combos.length) throw new Error('KEYS_EMPTY');
  if (combos.length > 12) throw new Error('KEYS_TOO_MANY');
  return combos.map(combo => {
    const parts = combo.toLowerCase().split('+').map(p => p.trim()).filter(Boolean);
    const vks = parts.map(p => {
      if (VK[p] !== undefined) return VK[p];
      if (/^f([1-9]|1\d|2[0-4])$/.test(p)) return 0x6f + Number(p.slice(1));
      if (/^[a-z0-9]$/.test(p)) return p.toUpperCase().charCodeAt(0);
      throw new Error(`KEY_UNKNOWN:${p}`);
    });
    if (vks.slice(0, -1).some(v => !MODIFIERS.has(v))) throw new Error(`KEY_ORDER:${combo}`);
    const set = new Set(vks);
    if (set.has(0x11) && set.has(0x12) && set.has(0x2e)) throw new Error('KEY_FORBIDDEN');
    return vks;
  });
}
/** A combo that would put text into the focused field (letters, digits, space or paste). */
export function comboTypesText(vks: number[]): boolean {
  const key = vks[vks.length - 1];
  const mods = vks.slice(0, -1);
  if (mods.includes(0x11) && key === 0x56) return true; // ctrl+v
  if (mods.includes(0x10) && key === 0x2d) return true; // shift+insert (Windows paste)
  if (mods.some(m => m === 0x11 || m === 0x12 || m === 0x5b)) return false;
  return (key >= 0x30 && key <= 0x5a) || key === 0x20 || key >= 0xba;
}

const MESSAGES = {
  tr: {
    disabled: 'Bilgisayar kullanımı kapalı. Kullanıcı "Ajanlar ve uygulamalar" bölümünden açabilir.',
    stopped: 'Kullanıcı bilgisayar kullanımını durdurdu (Esc ya da Durdur). Devam etmek için kullanıcıdan "Ajanlar ve uygulamalar" bölümünde sürdürmesini isteyin; şimdilik bilgisayara dokunmayın.',
    declined: 'Kullanıcı bu eylemi onaylamadı.',
    unsupported: 'Bilgisayar kullanımı şu an yalnız Windows\'ta destekleniyor.',
    locked: 'Ekran kilitli ya da güvenli masaüstü açık; Cude kilit ekranına dokunmaz.',
    elevated: 'Bu pencere yönetici (yükseltilmiş) yetkisiyle çalışıyor; Cude yönetici pencerelerine dokunmaz.',
    self: 'Bu pencere Cude\'un kendisine ait; Cude kendi onay pencerelerine ve arayüzüne tıklamaz.',
    protected: 'Bu uygulama korumalı listede (kilit/oturum, parola yöneticisi ya da sistem aracı); Cude dokunmaz.',
    'user-browser': 'Bu, kullanıcının kendi tarayıcısı; Cude kullanıcının tarayıcı profiline dokunmaz. Web için browser_open / browser_read araçlarını (izole Cude tarayıcısı) kullanın.',
    'not-allowed': 'Bu uygulama izin verilen uygulamalar listesinde değil. Kullanıcı listeyi "Ajanlar ve uygulamalar" bölümünden düzenleyebilir.',
    unknown: 'Hedef pencere bulunamadı. list_windows ile güncel listeyi alın.',
    password: 'Bu bir parola ya da gizli bilgi alanı; Cude parola, PIN ya da kart bilgisi yazmaz.',
    card: 'Metin bir kart numarasına benziyor; Cude kart bilgisi yazmaz.',
    needLook: 'Koordinatla tıklamadan önce güncel bir ekran görüntüsü gerekiyor (son 3 dakikada yok). Önce screen_capture ya da ui_tree kullanın.',
    needTarget: 'Hedef pencere belli değil. Önce focus_window ile pencereyi seçin ya da "window" verin.',
    focusFailed: 'Pencere öne getirilemedi; eylem yapılmadı. Kullanıcıdan pencereyi açmasını isteyin ya da focus_window deneyin.',
    staleElement: 'Öğe artık yok ya da liste eski. ui_tree ile yeniden listeleyin.',
  },
  en: {
    disabled: 'Computer use is turned off. The user can turn it on in "Agents and apps".',
    stopped: 'The user stopped computer use (Esc or Stop). Ask the user to resume it in "Agents and apps"; do not touch the computer for now.',
    declined: 'The user declined this action.',
    unsupported: 'Computer use is currently supported on Windows only.',
    locked: 'The screen is locked or a secure desktop is open; Cude never touches the lock screen.',
    elevated: 'This window runs as administrator (elevated); Cude never touches elevated windows.',
    self: 'This window belongs to Cude itself; Cude never clicks its own approval dialogs or UI.',
    protected: 'This app is protected (lock/sign-in, password manager or system tool); Cude does not touch it.',
    'user-browser': 'This is the user\'s own browser; Cude never touches the user\'s browser profile. Use browser_open / browser_read (the isolated Cude browser) for the web.',
    'not-allowed': 'This app is not in the allowed apps list. The user can edit the list in "Agents and apps".',
    unknown: 'The target window was not found. Use list_windows for a fresh list.',
    password: 'This is a password or secret field; Cude never types passwords, PINs or card details.',
    card: 'The text looks like a card number; Cude never types card details.',
    needLook: 'Clicking by coordinates needs a fresh screenshot (none in the last 3 minutes). Use screen_capture or ui_tree first.',
    needTarget: 'No target window. Use focus_window first or pass "window".',
    focusFailed: 'The window could not be brought to the front; nothing was done. Ask the user to open it or try focus_window.',
    staleElement: 'That element is gone or the list is stale. Run ui_tree again.',
  },
};
export type MessageId = keyof typeof MESSAGES.en;
export function computerMessage(id: MessageId, language: 'tr' | 'en' = 'en') { return MESSAGES[language][id] ?? MESSAGES.en[id]; }

/** Thrown inside actions to return a readable refusal to the model. */
class Refused extends Error { constructor(public readonly id: MessageId) { super(id); } }

const FRESH_LOOK_MS = 180_000;

export class ComputerUse {
  private stoppedFlag = false;
  private grants = new Set<string>();
  private browserPids = new Set<number>();
  private lastLook = 0;
  private lastTarget: WindowInfo | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  readonly log: Array<{ at: string; kind: string; app: string; detail: string; result: string }> = [];

  constructor(private o: ComputerOptions) {}

  private get lang(): 'tr' | 'en' { return this.o.language?.() ?? 'en'; }
  private msg(id: MessageId) { return computerMessage(id, this.lang); }
  private now() { return this.o.now?.() ?? Date.now(); }
  get stopped() { return this.stoppedFlag; }
  get sessionGrants() { return [...this.grants]; }

  allowBrowserPid(pid: number | undefined) { if (pid) this.browserPids.add(pid); }
  forgetBrowserPid(pid: number | undefined) { if (pid) this.browserPids.delete(pid); }

  /** Esc, the bar's Stop button or the status bar item. Kills the helper so in-flight typing ends at once. */
  stop() {
    if (this.stoppedFlag) return;
    this.stoppedFlag = true;
    this.grants.clear();
    try { this.o.driver.dispose(); } catch { }
    try { this.o.bar?.hide(); } catch { }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.o.ui?.stopped?.();
  }
  resume() { this.stoppedFlag = false; }
  clearGrants() { this.grants.clear(); }
  dispose() { try { this.o.bar?.dispose(); } catch { } try { this.o.driver.dispose(); } catch { } if (this.idleTimer) clearTimeout(this.idleTimer); }

  private rules(): TargetRules {
    return { selfProcesses: this.o.selfProcesses ?? [], browserPids: this.browserPids, allowedApps: this.o.settings().allowedApps ?? [] };
  }
  private ensureUsable() {
    if (this.stoppedFlag) throw new Refused('stopped');
    if (!this.o.settings().enabled) throw new Refused('disabled');
  }
  private appLabel(t: Partial<TargetInfo>) { return t.process ? `${t.process}${t.title ? ` — ${String(t.title).slice(0, 60)}` : ''}` : (this.lang === 'tr' ? 'ekran' : 'screen'); }

  /** Approval gate. Every action goes through here; nothing runs without an explicit yes (or a session grant for that app). */
  async approve(kind: ActionKind, target: Partial<TargetInfo> | undefined, title: string, detail: string, opts: { sessionable?: boolean; key?: string } = {}) {
    this.ensureUsable();
    if (target) { const refusal = targetRefusal(target, this.rules()); if (refusal) throw new Refused(refusal); }
    const key = (opts.key ?? String(target?.process || 'screen')).toLowerCase();
    const sessionable = opts.sessionable !== false;
    if (sessionable && this.grants.has(key)) return;
    this.o.bar?.show(this.lang === 'tr' ? 'Cude onayınızı bekliyor…' : 'Cude is waiting for your approval…');
    try { await this.o.revealIde?.(); } catch { }
    const answer = await this.o.approver({ title, detail, app: target ? this.appLabel(target) : key, sessionable, kind });
    if (this.stoppedFlag) throw new Refused('stopped');
    if (answer === 'deny') { this.record(kind, key, detail, 'declined'); this.markIdleSoon(); throw new Refused('declined'); }
    if (answer === 'session' && sessionable) this.grants.add(key);
  }

  private markActive(label: string) {
    this.o.bar?.show(label);
    this.o.ui?.active?.(label);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.markIdleSoon();
  }
  private markIdleSoon() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { try { this.o.bar?.hide(); } catch { } this.o.ui?.idle?.(); }, 30_000);
    this.idleTimer.unref?.();
  }
  private record(kind: string, app: string, detail: string, result: string) {
    this.log.push({ at: new Date(this.now()).toISOString(), kind, app, detail: detail.slice(0, 200), result });
    if (this.log.length > 200) this.log.shift();
  }

  /** Runs an action and turns refusals into readable observations. */
  private async guard(run: () => Promise<string>): Promise<string> {
    if (process.platform !== 'win32' && !(this.o as any).allowAnyPlatform) return this.msg('unsupported');
    try { return await run(); }
    catch (error: any) {
      if (error instanceof Refused) return this.msg(error.id);
      const code = String(error?.message || error);
      if (/PASSWORD_FIELD/.test(code)) return this.msg('password');
      if (/FOCUS_FAILED/.test(code)) return this.msg('focusFailed');
      if (/ELEMENT_(UNKNOWN|STALE)|ElementNotAvailable/.test(code)) return this.msg('staleElement');
      if (/WINDOW_GONE/.test(code)) return this.msg('unknown');
      if (/WINDOW_MINIMIZED/.test(code)) return this.lang === 'tr' ? 'Pencere simge durumunda; önce focus_window kullanın.' : 'The window is minimized; use focus_window first.';
      if (/^KEY_/.test(code)) return `${this.lang === 'tr' ? 'Tuş bilgisi anlaşılamadı' : 'Could not parse keys'} (${code}). ${this.lang === 'tr' ? 'Örnek' : 'Example'}: "ctrl+s", "alt+f4", "enter".`;
      if (this.stoppedFlag) return this.msg('stopped');
      return `Computer use error: ${code.slice(0, 300)}`;
    }
  }

  async windows(): Promise<WindowInfo[]> { return (await this.o.driver.call<WindowInfo[]>('windows')) || []; }

  /** Finds a window by id, exact/partial title or process name. */
  async resolveWindow(ref: unknown): Promise<WindowInfo | undefined> {
    const list = await this.windows();
    if (ref === undefined || ref === null || ref === '') return this.lastTarget ? list.find(w => w.id === this.lastTarget!.id) : undefined;
    const text = String(ref).trim().toLowerCase();
    if (/^\d+$/.test(text)) { const byId = list.find(w => String(w.id) === text); if (byId) return byId; }
    return list.find(w => w.title.toLowerCase() === text) || list.find(w => w.process.toLowerCase() === text.replace(/\.exe$/, ''))
      || list.find(w => w.title.toLowerCase().includes(text)) || list.find(w => w.process.toLowerCase().includes(text));
  }

  listWindows(): Promise<string> {
    return this.guard(async () => {
      this.ensureUsable();
      const rules = this.rules();
      const rows = (await this.windows()).slice(0, 80).map(w => {
        const refusal = targetRefusal(w, rules);
        const flags = [w.foreground ? 'foreground' : '', w.minimized ? 'minimized' : '', refusal ? `blocked:${refusal}` : ''].filter(Boolean).join(',');
        return `${w.id} | ${w.process} | ${w.title.slice(0, 90)} | ${w.x},${w.y} ${w.width}x${w.height}${flags ? ` | ${flags}` : ''}`;
      });
      return rows.length ? `id | app | title | position size | flags\n${rows.join('\n')}` : (this.lang === 'tr' ? 'Açık pencere yok.' : 'No open windows.');
    });
  }

  private async uiElements(window: WindowInfo, max = 200): Promise<UiElement[]> {
    return (await this.o.driver.call<UiElement[]>('uitree', { window: window.id, max }, 20000)) || [];
  }
  static formatElements(list: UiElement[], limit = 200) {
    return list.slice(0, limit).map(e => {
      const secret = !!(e.password || SENSITIVE_NAME.test(e.name || '') || SENSITIVE_NAME.test(e.automationId || '') || (e.value && looksLikeCardNumber(e.value)));
      return `${e.id} ${e.type}${e.name ? ` "${e.name}"` : ''}${e.automationId ? ` #${e.automationId}` : ''} @${e.x + Math.round(e.width / 2)},${e.y + Math.round(e.height / 2)}${e.password || secret ? ' [password]' : ''}${e.enabled === false ? ' [disabled]' : ''}${e.focused ? ' [focused]' : ''}${!secret && e.value ? ` value="${e.value.slice(0, 80)}"` : ''}`;
    }).join('\n');
  }

  uiTree(args: { window?: unknown; max?: number }): Promise<string> {
    return this.guard(async () => {
      this.ensureUsable();
      const w = await this.resolveWindow(args.window);
      if (!w) throw new Refused(args.window ? 'unknown' : 'needTarget');
      await this.approve('read', w, this.lang === 'tr' ? `Cude bu pencerenin öğelerini okusun mu?` : 'Let Cude read the elements of this window?', `${this.appLabel(w)}`);
      const list = await this.uiElements(w, Math.min(400, Math.max(10, Number(args.max) || 200)));
      this.lastLook = this.now(); this.lastTarget = w;
      this.record('read', w.process, w.title, `${list.length} elements`);
      return list.length ? `Window ${w.id} ${w.process} "${w.title.slice(0, 80)}" (${w.x},${w.y} ${w.width}x${w.height})\n${ComputerUse.formatElements(list)}\nClick with {"element":"eN"}; type with {"element":"eN","text":"..."}.`
        : (this.lang === 'tr' ? 'Bu pencerede seçilebilir öğe bulunamadı; screen_capture ile koordinat kullanın.' : 'No selectable elements found; use screen_capture and coordinates.');
    });
  }

  screenCapture(args: { window?: unknown }): Promise<string> {
    return this.guard(async () => {
      this.ensureUsable();
      const tr = this.lang === 'tr';
      let w: WindowInfo | undefined;
      if (args.window !== undefined && args.window !== '') { w = await this.resolveWindow(args.window); if (!w) throw new Refused('unknown'); }
      const locked = await this.o.driver.call<boolean>('locked').catch(() => false);
      if (locked) throw new Refused('locked');
      if (w) await this.approve('capture', w, tr ? 'Cude bu pencerenin ekran görüntüsünü alsın mı?' : 'Let Cude take a screenshot of this window?', `${this.appLabel(w)}\n${tr ? 'Görüntü modele gönderilebilir.' : 'The image may be sent to the model.'}`);
      else await this.approve('capture', undefined, tr ? 'Cude tüm ekranın görüntüsünü alsın mı?' : 'Let Cude take a screenshot of the whole screen?', tr ? 'Ekrandaki her şey (açık pencereler dahil) görüntüye girer ve modele gönderilebilir.' : 'Everything on screen (all open windows) is captured and may be sent to the model.', { key: 'screen' });
      const dir = this.o.shotDir ?? path.join(os.tmpdir(), 'cude-computer');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `shot-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.png`);
      // Approved capture of a minimized window: restore it first (focus un-minimizes) instead of failing.
      if (w?.minimized) { await this.o.driver.call<boolean>('focus', { window: w.id }).catch(() => false); await new Promise(r => setTimeout(r, 350)); }
      const shot = await this.o.driver.call<{ x: number; y: number; width: number; height: number }>('capture', { window: w?.id ?? 0, path: file }, 20000);
      this.lastLook = this.now(); if (w) this.lastTarget = w;
      this.markActive(tr ? 'Cude ekranı kullanıyor' : 'Cude is using the screen');
      // Text fallback for providers without image input: the selectable elements of the captured (or front) window.
      let elementsText = '';
      try {
        const focus = w ?? (await this.windows()).find(x => x.foreground);
        if (focus && !targetRefusal(focus, this.rules())) {
          const list = await this.uiElements(focus, 80);
          if (list.length) elementsText = `\nUI elements of ${focus.process} "${focus.title.slice(0, 60)}" (window ${focus.id}):\n${ComputerUse.formatElements(list, 80)}`;
          if (!w) this.lastTarget = focus;
        }
      } catch { }
      this.record('capture', w?.process ?? 'screen', file, 'ok');
      return `Screenshot saved: ${file}\n[image: ${file}]\nArea: origin (${shot.x}, ${shot.y}), size ${shot.width}x${shot.height}. Screen coordinates = image pixel + origin.${elementsText}`;
    });
  }

  focusWindow(args: { window?: unknown }): Promise<string> {
    return this.guard(async () => {
      this.ensureUsable();
      const w = await this.resolveWindow(args.window);
      if (!w) throw new Refused(args.window ? 'unknown' : 'needTarget');
      await this.approve('focus', w, this.lang === 'tr' ? 'Cude bu pencereyi öne getirsin mi?' : 'Let Cude bring this window to the front?', this.appLabel(w));
      if (!await this.o.driver.call<boolean>('focus', { window: w.id })) throw new Refused('focusFailed');
      this.lastTarget = w;
      this.markActive(this.lang === 'tr' ? `Cude ekranı kullanıyor · ${w.process}` : `Cude is using the screen · ${w.process}`);
      this.record('focus', w.process, w.title, 'ok');
      return `Focused window ${w.id} ${w.process} "${w.title.slice(0, 80)}".`;
    });
  }

  click(args: { element?: string; x?: number; y?: number; window?: unknown; button?: string; double?: boolean }): Promise<string> {
    return this.guard(async () => {
      this.ensureUsable();
      const tr = this.lang === 'tr';
      const byElement = typeof args.element === 'string' && args.element.trim() !== '';
      if (!byElement) {
        if (!Number.isFinite(Number(args.x)) || !Number.isFinite(Number(args.y))) return tr ? 'Bir öğe ("element":"e3") ya da koordinat ("x","y") verin.' : 'Give an element ("element":"e3") or coordinates ("x","y").';
        if (this.now() - this.lastLook > FRESH_LOOK_MS) throw new Refused('needLook');
      }
      const target = await this.o.driver.call<TargetInfo>('target', byElement ? { element: args.element } : { x: Math.round(Number(args.x)), y: Math.round(Number(args.y)) });
      const button = ['left', 'right', 'middle'].includes(String(args.button)) ? String(args.button) : 'left';
      const what = target.elementName ? `"${target.elementName}"` : `(${target.pointX}, ${target.pointY})`;
      await this.approve('click', target, tr ? `Cude ${what} öğesine tıklasın mı?` : `Let Cude click ${what}?`, `${this.appLabel(target)}\n${button}${args.double ? ' double' : ''} click @ ${target.pointX},${target.pointY}`);
      if (!await this.o.driver.call<boolean>('focus', { window: target.id })) throw new Refused('focusFailed');
      // Re-check the point after focusing: the window under the cursor must still be the approved one.
      const again = await this.o.driver.call<TargetInfo>('target', { x: target.pointX, y: target.pointY });
      if (again.id !== target.id || targetRefusal(again, this.rules())) throw new Refused('focusFailed');
      await this.o.driver.call('click', { x: target.pointX, y: target.pointY, button, double: !!args.double });
      this.lastTarget = target;
      this.markActive(tr ? `Cude ekranı kullanıyor · ${target.process}` : `Cude is using the screen · ${target.process}`);
      this.record('click', target.process, what, 'ok');
      return `Clicked ${what} in ${target.process} "${String(target.title).slice(0, 60)}". Take a screenshot or ui_tree to see the result.`;
    });
  }

  typeText(args: { text?: string; element?: string; window?: unknown }): Promise<string> {
    return this.guard(async () => {
      this.ensureUsable();
      const tr = this.lang === 'tr';
      const text = String(args.text ?? '');
      if (!text) return tr ? 'Yazılacak metni "text" ile verin.' : 'Give the text to type in "text".';
      if (text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return tr ? 'Metin en fazla 4000 karakter olabilir ve kontrol karakteri içeremez.' : 'Text must be at most 4000 characters without control characters.';
      const byElement = typeof args.element === 'string' && args.element.trim() !== '';
      let target: TargetInfo;
      if (byElement) target = await this.o.driver.call<TargetInfo>('target', { element: args.element });
      else {
        const w = await this.resolveWindow(args.window);
        if (!w) throw new Refused(args.window ? 'unknown' : 'needTarget');
        target = { ...w, ...(await this.o.driver.call<TargetInfo>('target', { window: w.id })), id: w.id };
      }
      const refusal = typingRefusal(text, { password: target.password, name: target.elementName });
      if (refusal) { this.record('type', target.process, '(refused)', refusal); throw new Refused(refusal); }
      const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      await this.approve('type', target, tr ? `Cude ${target.process} uygulamasına yazsın mı?` : `Let Cude type into ${target.process}?`, `${this.appLabel(target)}${target.elementName ? ` · "${target.elementName}"` : ''}\n${tr ? 'Metin' : 'Text'}: "${preview}"`);
      await this.o.driver.call('type', { window: target.id, element: byElement ? args.element : '', text }, 60000);
      this.lastTarget = target;
      this.markActive(tr ? `Cude yazıyor · ${target.process}` : `Cude is typing · ${target.process}`);
      this.record('type', target.process, `${text.length} chars`, 'ok');
      return `Typed ${text.length} characters into ${target.process} "${String(target.title).slice(0, 60)}".`;
    });
  }

  pressKeys(args: { keys?: string | string[]; window?: unknown }): Promise<string> {
    return this.guard(async () => {
      this.ensureUsable();
      const tr = this.lang === 'tr';
      const combos = parseKeys(args.keys ?? '');
      const w = await this.resolveWindow(args.window);
      if (!w) throw new Refused(args.window ? 'unknown' : 'needTarget');
      const target = { ...w, ...(await this.o.driver.call<TargetInfo>('target', { window: w.id })), id: w.id };
      if (combos.some(comboTypesText)) {
        const refusal = typingRefusal('', { password: target.password, name: target.elementName });
        if (refusal) { this.record('keys', target.process, '(refused)', refusal); throw new Refused(refusal); }
      }
      const label = Array.isArray(args.keys) ? args.keys.join(', ') : String(args.keys);
      await this.approve('keys', target, tr ? `Cude ${target.process} penceresinde "${label}" tuşlarına bassın mı?` : `Let Cude press "${label}" in ${target.process}?`, this.appLabel(target));
      for (const vks of combos) await this.o.driver.call('keys', { window: target.id, vks, textLike: comboTypesText(vks) });
      this.lastTarget = target;
      this.markActive(tr ? `Cude ekranı kullanıyor · ${target.process}` : `Cude is using the screen · ${target.process}`);
      this.record('keys', target.process, label, 'ok');
      return `Pressed ${label} in ${target.process} "${String(target.title).slice(0, 60)}".`;
    });
  }

  scroll(args: { element?: string; x?: number; y?: number; amount?: number; horizontal?: boolean }): Promise<string> {
    return this.guard(async () => {
      this.ensureUsable();
      const tr = this.lang === 'tr';
      const byElement = typeof args.element === 'string' && args.element.trim() !== '';
      let point: Record<string, unknown>;
      if (byElement) point = { element: args.element };
      else if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) point = { x: Math.round(Number(args.x)), y: Math.round(Number(args.y)) };
      else if (this.lastTarget) point = { x: this.lastTarget.x + Math.round(this.lastTarget.width / 2), y: this.lastTarget.y + Math.round(this.lastTarget.height / 2) };
      else throw new Refused('needTarget');
      const target = await this.o.driver.call<TargetInfo>('target', point);
      const amount = Math.max(-30, Math.min(30, Math.round(Number(args.amount) || -3)));
      await this.approve('scroll', target, tr ? `Cude ${target.process} penceresini kaydırsın mı?` : `Let Cude scroll ${target.process}?`, `${this.appLabel(target)}\n${amount} @ ${target.pointX},${target.pointY}`);
      if (!await this.o.driver.call<boolean>('focus', { window: target.id })) throw new Refused('focusFailed');
      const again = await this.o.driver.call<TargetInfo>('target', { x: target.pointX, y: target.pointY });
      if (again.id !== target.id || targetRefusal(again, this.rules())) throw new Refused('focusFailed');
      await this.o.driver.call('scroll', { x: target.pointX, y: target.pointY, amount, horizontal: !!args.horizontal });
      this.lastTarget = target;
      this.markActive(tr ? `Cude ekranı kullanıyor · ${target.process}` : `Cude is using the screen · ${target.process}`);
      this.record('scroll', target.process, String(amount), 'ok');
      return `Scrolled ${amount} in ${target.process}.`;
    });
  }

  /** Lets other modules (open_app) reuse the approval gate and refusal messages. */
  gate(kind: ActionKind, target: Partial<TargetInfo> | undefined, title: string, detail: string, opts?: { sessionable?: boolean; key?: string }) {
    return this.guard(async () => { await this.approve(kind, target, title, detail, opts); return ''; });
  }
  noteTarget(w: WindowInfo) { this.lastTarget = w; this.markActive(this.lang === 'tr' ? `Cude ekranı kullanıyor · ${w.process}` : `Cude is using the screen · ${w.process}`); }
}

// ---------- Windows native helper (persistent PowerShell + C#) ----------
const HELPER_CS = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Web.Script.Serialization;

public static class CudeComputer {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint f, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int idx, StringBuilder buf, int len, out int needed);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr t);
  [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr t, int cls, out int info, int len, out int ret);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);

  static Dictionary<string, AutomationElement> elements = new Dictionary<string, AutomationElement>();
  static int counter = 0;
  static readonly ControlType[] Interesting = new ControlType[] { ControlType.Button, ControlType.Edit, ControlType.Hyperlink, ControlType.CheckBox, ControlType.RadioButton, ControlType.ComboBox, ControlType.MenuItem, ControlType.ListItem, ControlType.TabItem, ControlType.TreeItem, ControlType.Document, ControlType.SplitButton, ControlType.Slider, ControlType.Spinner, ControlType.DataItem };

  static long Num(Dictionary<string, object> a, string k, long d) { object v; if (a != null && a.TryGetValue(k, out v) && v != null) { try { return Convert.ToInt64(v); } catch { } } return d; }
  static string Str(Dictionary<string, object> a, string k) { object v; if (a != null && a.TryGetValue(k, out v) && v != null) return Convert.ToString(v); return ""; }
  static bool Bool(Dictionary<string, object> a, string k) { object v; if (a != null && a.TryGetValue(k, out v) && v is bool) return (bool)v; return false; }
  static string Clip(string s, int n) { if (s == null) return ""; s = s.Replace("\r", " ").Replace("\n", " "); return s.Length > n ? s.Substring(0, n) : s; }

  static object Elevation(uint pid) {
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return "denied";
    try {
      IntPtr t;
      if (!OpenProcessToken(p, 8, out t)) return "denied";
      try { int e; int r; if (GetTokenInformation(t, 20, out e, 4, out r)) return e != 0; return "denied"; }
      finally { CloseHandle(t); }
    } finally { CloseHandle(p); }
  }

  static Dictionary<string, object> WindowInfo(IntPtr h) {
    var d = new Dictionary<string, object>();
    uint pid; GetWindowThreadProcessId(h, out pid);
    int len = GetWindowTextLength(h); var sb = new StringBuilder(len + 2); GetWindowText(h, sb, sb.Capacity);
    RECT r; GetWindowRect(h, out r);
    string name = ""; try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }
    d["id"] = h.ToInt64(); d["title"] = sb.ToString(); d["process"] = name; d["pid"] = (long)pid;
    d["x"] = r.Left; d["y"] = r.Top; d["width"] = r.Right - r.Left; d["height"] = r.Bottom - r.Top;
    d["minimized"] = IsIconic(h); d["elevated"] = pid == 0 ? (object)"denied" : Elevation(pid); d["foreground"] = GetForegroundWindow() == h;
    d["owner"] = GetWindow(h, 4).ToInt64();
    return d;
  }

  static object ListWindows() {
    var list = new List<object>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;
      RECT r; GetWindowRect(h, out r); if (r.Right - r.Left < 2 || r.Bottom - r.Top < 2) return true;
      list.Add(WindowInfo(h)); return true;
    }, IntPtr.Zero);
    return list;
  }

  static bool Locked() {
    IntPtr d = OpenInputDesktop(0, false, 0x0100);
    if (d == IntPtr.Zero) return true;
    try { var sb = new StringBuilder(256); int n; if (GetUserObjectInformation(d, 2, sb, 512, out n) && !string.Equals(sb.ToString(), "Default", StringComparison.OrdinalIgnoreCase)) return true; }
    finally { CloseDesktop(d); }
    uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    try { string p = Process.GetProcessById((int)pid).ProcessName; if (p.Equals("LockApp", StringComparison.OrdinalIgnoreCase) || p.Equals("LogonUI", StringComparison.OrdinalIgnoreCase)) return true; } catch { }
    return false;
  }

  static object Capture(Dictionary<string, object> a) {
    string path = Str(a, "path"); long id = Num(a, "window", 0);
    Rectangle rect; Bitmap bmp;
    if (id != 0) {
      IntPtr h = new IntPtr(id);
      if (!IsWindow(h)) throw new Exception("WINDOW_GONE");
      if (IsIconic(h)) throw new Exception("WINDOW_MINIMIZED");
      RECT r; GetWindowRect(h, out r);
      int w = Math.Max(1, r.Right - r.Left), hh = Math.Max(1, r.Bottom - r.Top);
      bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(bmp)) {
        IntPtr hdc = g.GetHdc(); bool ok = PrintWindow(h, hdc, 2); g.ReleaseHdc(hdc);
        if (!ok) g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(w, hh));
      }
      rect = new Rectangle(r.Left, r.Top, w, hh);
    } else {
      rect = System.Windows.Forms.SystemInformation.VirtualScreen;
      bmp = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(rect.Left, rect.Top, 0, 0, rect.Size);
    }
    try { bmp.Save(path, ImageFormat.Png); } finally { bmp.Dispose(); }
    var d = new Dictionary<string, object>();
    d["x"] = rect.X; d["y"] = rect.Y; d["width"] = rect.Width; d["height"] = rect.Height; d["path"] = path;
    return d;
  }

  static void Walk(AutomationElement el, int depth, List<object> list, int max, Stopwatch sw) {
    if (depth > 25 || list.Count >= max || sw.ElapsedMilliseconds > 8000) return;
    AutomationElement child;
    try { child = TreeWalker.ControlViewWalker.GetFirstChild(el); } catch { return; }
    while (child != null && list.Count < max && sw.ElapsedMilliseconds < 8000) {
      try { Consider(child, list); } catch { }
      Walk(child, depth + 1, list, max, sw);
      try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); } catch { break; }
    }
  }
  static void Consider(AutomationElement el, List<object> list) {
    var c = el.Current;
    if (c.IsOffscreen) return;
    var rect = c.BoundingRectangle;
    if (rect.IsEmpty || rect.Width < 1 || rect.Height < 1) return;
    bool interesting = Array.IndexOf(Interesting, c.ControlType) >= 0 || (c.IsKeyboardFocusable && !string.IsNullOrEmpty(c.Name));
    if (!interesting) return;
    string id = "e" + (++counter);
    elements[id] = el;
    var d = new Dictionary<string, object>();
    d["id"] = id; d["type"] = c.ControlType.ProgrammaticName.Replace("ControlType.", ""); d["name"] = Clip(c.Name, 80); d["automationId"] = Clip(c.AutomationId, 60);
    d["x"] = (int)rect.X; d["y"] = (int)rect.Y; d["width"] = (int)rect.Width; d["height"] = (int)rect.Height;
    d["enabled"] = c.IsEnabled; d["password"] = c.IsPassword; d["focused"] = c.HasKeyboardFocus;
    if (!c.IsPassword && (c.ControlType == ControlType.Edit || c.ControlType == ControlType.Document)) {
      object vp; if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) { try { d["value"] = Clip(((ValuePattern)vp).Current.Value, 200); } catch { } }
    }
    list.Add(d);
  }
  static object UiTree(Dictionary<string, object> a) {
    IntPtr h = new IntPtr(Num(a, "window", 0));
    if (!IsWindow(h)) throw new Exception("WINDOW_GONE");
    int max = (int)Num(a, "max", 200);
    elements.Clear(); counter = 0;
    var list = new List<object>();
    var root = AutomationElement.FromHandle(h);
    Walk(root, 0, list, max, Stopwatch.StartNew());
    return list;
  }

  static AutomationElement Element(string id) {
    AutomationElement el;
    if (!elements.TryGetValue(id, out el)) throw new Exception("ELEMENT_UNKNOWN");
    return el;
  }

  static object Target(Dictionary<string, object> a) {
    string eid = Str(a, "element"); IntPtr h = IntPtr.Zero; int x = 0, y = 0; bool hasPoint = false, pwd = false; string ename = "";
    if (eid != "") {
      var el = Element(eid);
      try {
        var c = el.Current; pwd = c.IsPassword; ename = c.Name;
        System.Windows.Point p;
        if (!el.TryGetClickablePoint(out p)) { var r = c.BoundingRectangle; p = new System.Windows.Point(r.X + r.Width / 2, r.Y + r.Height / 2); }
        x = (int)p.X; y = (int)p.Y; hasPoint = true;
      } catch (ElementNotAvailableException) { throw new Exception("ELEMENT_STALE"); }
    } else if (a.ContainsKey("x")) { x = (int)Num(a, "x", 0); y = (int)Num(a, "y", 0); hasPoint = true; }
    if (hasPoint) { POINT pt; pt.X = x; pt.Y = y; h = WindowFromPoint(pt); }
    else if (Num(a, "window", 0) != 0) h = new IntPtr(Num(a, "window", 0));
    else h = GetForegroundWindow();
    IntPtr root = GetAncestor(h, 2); if (root != IntPtr.Zero) h = root;
    if (h == IntPtr.Zero || !IsWindow(h)) throw new Exception("WINDOW_GONE");
    var info = WindowInfo(h);
    if (!hasPoint && eid == "") {
      try { var f = AutomationElement.FocusedElement; if (f != null) { var fc = f.Current; uint fpid; GetWindowThreadProcessId(h, out fpid); if (fc.ProcessId == (int)fpid) { pwd = fc.IsPassword; ename = fc.Name; } } } catch { }
    }
    info["pointX"] = x; info["pointY"] = y; info["hasPoint"] = hasPoint; info["password"] = pwd; info["elementName"] = Clip(ename, 80); info["locked"] = Locked();
    return info;
  }

  static void Send(List<INPUT> inputs) {
    if (inputs.Count == 0) return;
    var arr = inputs.ToArray();
    if (SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT))) != arr.Length) throw new Exception("INPUT_BLOCKED");
  }
  static INPUT Key(ushort vk, bool up) {
    var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk;
    uint flags = up ? 2u : 0u;
    if ((vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x6F) flags |= 1u;
    i.u.ki.dwFlags = flags; return i;
  }
  static INPUT Unicode(char ch, bool up) { var i = new INPUT(); i.type = 1; i.u.ki.wScan = ch; i.u.ki.dwFlags = 4u | (up ? 2u : 0u); return i; }
  static INPUT Mouse(uint flags, int data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }

  static bool Focus(IntPtr h) {
    if (!IsWindow(h)) throw new Exception("WINDOW_GONE");
    if (IsIconic(h)) { ShowWindow(h, 9); Thread.Sleep(150); }
    if (GetForegroundWindow() == h) return true;
    IntPtr fg = GetForegroundWindow(); uint fgPid; uint fgThread = GetWindowThreadProcessId(fg, out fgPid); uint me = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
    try { BringWindowToTop(h); SetForegroundWindow(h); } finally { if (attached) AttachThreadInput(me, fgThread, false); }
    for (int i = 0; i < 15 && GetForegroundWindow() != h; i++) Thread.Sleep(30);
    if (GetForegroundWindow() != h) {
      // Fallback: a harmless synthetic Shift tap lets this process set the foreground window.
      Send(new List<INPUT> { Key(0x10, false), Key(0x10, true) });
      SetForegroundWindow(h);
      for (int i = 0; i < 20 && GetForegroundWindow() != h; i++) Thread.Sleep(30);
    }
    return GetForegroundWindow() == h;
  }

  static readonly System.Text.RegularExpressions.Regex SensitiveRe = new System.Text.RegularExpressions.Regex(@"pass(?:word|wd|code)?\b|parola|şifre|sifre|\bpin\b|cvv|cvc|csc\b|card.?(?:number|no|num)|cc-?(?:num|number|csc|exp)|kart|iban|one.?time|\botp\b|security.?code|güvenlik kodu|\bssn\b|\btckn\b|kimlik", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
  static bool FocusedIsPassword() { try { var f = AutomationElement.FocusedElement; if (f == null) return false; var c = f.Current; return c.IsPassword || (!string.IsNullOrEmpty(c.Name) && SensitiveRe.IsMatch(c.Name)); } catch { return false; } }

  static object TypeText(Dictionary<string, object> a) {
    IntPtr h = new IntPtr(Num(a, "window", 0));
    if (h != IntPtr.Zero && !Focus(h)) throw new Exception("FOCUS_FAILED");
    string eid = Str(a, "element");
    if (eid != "") {
      var el = Element(eid);
      try { if (el.Current.IsPassword) throw new Exception("PASSWORD_FIELD"); el.SetFocus(); } catch (ElementNotAvailableException) { throw new Exception("ELEMENT_STALE"); } catch (InvalidOperationException) { }
      Thread.Sleep(80);
    }
    if (FocusedIsPassword()) throw new Exception("PASSWORD_FIELD");
    if (h != IntPtr.Zero && GetAncestor(GetForegroundWindow(), 2) != GetAncestor(h, 2)) throw new Exception("FOCUS_FAILED");
    string text = Str(a, "text");
    var batch = new List<INPUT>();
    foreach (char ch in text) {
      if (ch == '\r') continue;
      if (ch == '\n') { batch.Add(Key(0x0D, false)); batch.Add(Key(0x0D, true)); }
      else if (ch == '\t') { batch.Add(Key(0x09, false)); batch.Add(Key(0x09, true)); }
      else { batch.Add(Unicode(ch, false)); batch.Add(Unicode(ch, true)); }
      if (batch.Count >= 60) { Send(batch); batch.Clear(); Thread.Sleep(15); }
    }
    Send(batch);
    return true;
  }

  static object Keys(Dictionary<string, object> a) {
    IntPtr h = new IntPtr(Num(a, "window", 0));
    if (h != IntPtr.Zero && !Focus(h)) throw new Exception("FOCUS_FAILED");
    if (Bool(a, "textLike") && FocusedIsPassword()) throw new Exception("PASSWORD_FIELD");
    var vks = new List<ushort>();
    object raw; if (a.TryGetValue("vks", out raw) && raw is IEnumerable) foreach (object o in (IEnumerable)raw) vks.Add((ushort)Convert.ToInt32(o));
    if (vks.Count == 0) throw new Exception("KEYS_EMPTY");
    var batch = new List<INPUT>();
    for (int i = 0; i < vks.Count; i++) batch.Add(Key(vks[i], false));
    for (int i = vks.Count - 1; i >= 0; i--) batch.Add(Key(vks[i], true));
    Send(batch);
    Thread.Sleep(60);
    return true;
  }

  static object Click(Dictionary<string, object> a) {
    int x = (int)Num(a, "x", 0), y = (int)Num(a, "y", 0);
    string button = Str(a, "button"); bool dbl = Bool(a, "double");
    uint down = 0x0002, up = 0x0004;
    if (button == "right") { down = 0x0008; up = 0x0010; } else if (button == "middle") { down = 0x0020; up = 0x0040; }
    if (!SetCursorPos(x, y)) throw new Exception("CURSOR_FAILED");
    Thread.Sleep(50);
    for (int i = 0; i < (dbl ? 2 : 1); i++) { Send(new List<INPUT> { Mouse(down, 0) }); Thread.Sleep(30); Send(new List<INPUT> { Mouse(up, 0) }); Thread.Sleep(70); }
    return true;
  }

  static object Scroll(Dictionary<string, object> a) {
    int x = (int)Num(a, "x", 0), y = (int)Num(a, "y", 0), amount = (int)Num(a, "amount", -3);
    if (!SetCursorPos(x, y)) throw new Exception("CURSOR_FAILED");
    Thread.Sleep(40);
    Send(new List<INPUT> { Mouse(Bool(a, "horizontal") ? 0x01000u : 0x0800u, amount * 120) });
    return true;
  }

  static object Handle(string op, Dictionary<string, object> a) {
    switch (op) {
      case "ping": return "pong";
      case "windows": return ListWindows();
      case "locked": return Locked();
      case "foreground": return WindowInfo(GetForegroundWindow());
      case "capture": if (Locked()) throw new Exception("LOCKED"); return Capture(a);
      case "uitree": return UiTree(a);
      case "target": return Target(a);
      case "focus": return Focus(new IntPtr(Num(a, "window", 0)));
      case "type": return TypeText(a);
      case "keys": return Keys(a);
      case "click": return Click(a);
      case "scroll": return Scroll(a);
    }
    throw new Exception("UNKNOWN_OP " + op);
  }

  public static void Run() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
    var js = new JavaScriptSerializer(); js.MaxJsonLength = int.MaxValue;
    var stdout = new System.IO.StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)); stdout.AutoFlush = true;
    var stdin = new System.IO.StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    string line;
    while ((line = stdin.ReadLine()) != null) {
      var res = new Dictionary<string, object>();
      object id = null;
      try {
        var req = js.Deserialize<Dictionary<string, object>>(line);
        id = req.ContainsKey("id") ? req["id"] : null;
        var args = req.ContainsKey("args") ? req["args"] as Dictionary<string, object> : null;
        res["result"] = Handle(Convert.ToString(req["op"]), args ?? new Dictionary<string, object>());
        res["ok"] = true;
      } catch (Exception e) { var inner = e.InnerException ?? e; res["ok"] = false; res["error"] = inner.Message; }
      res["id"] = id;
      stdout.WriteLine(js.Serialize(res));
    }
  }
}
`;

const BAR_CS = String.raw`
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public class CudeBar : Form {
  delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc p, IntPtr mod, uint tid);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int c, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string n);
  [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr h, uint a);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  static HookProc proc; static IntPtr hook; static CudeBar bar;
  Label label; Button stopButton; bool stopped; string stoppedText;
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { var cp = base.CreateParams; cp.ExStyle |= 0x08000000 | 0x80 | 0x8; return cp; } }
  CudeBar(string text, string stopText, string stoppedText) {
    this.stoppedText = stoppedText;
    FormBorderStyle = FormBorderStyle.None; TopMost = true; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual;
    BackColor = Color.FromArgb(31, 27, 24); Size = new Size(560, 38); Text = "Cude";
    var area = Screen.PrimaryScreen.WorkingArea; Location = new Point(area.Left + (area.Width - Width) / 2, area.Top + 8);
    var dot = new Label(); dot.Text = "\u25CF"; dot.ForeColor = Color.FromArgb(232, 84, 84); dot.Font = new Font("Segoe UI", 11f); dot.AutoSize = false; dot.Bounds = new Rectangle(10, 7, 20, 24); dot.TextAlign = ContentAlignment.MiddleCenter;
    label = new Label(); label.Text = text; label.ForeColor = Color.White; label.Font = new Font("Segoe UI", 9.5f); label.AutoSize = false; label.Bounds = new Rectangle(34, 7, 420, 24); label.TextAlign = ContentAlignment.MiddleLeft; label.AutoEllipsis = true;
    stopButton = new Button(); stopButton.Text = stopText; stopButton.FlatStyle = FlatStyle.Flat; stopButton.BackColor = Color.FromArgb(214, 155, 112); stopButton.ForeColor = Color.FromArgb(31, 27, 24);
    stopButton.Font = new Font("Segoe UI Semibold", 9f); stopButton.Bounds = new Rectangle(460, 6, 90, 26); stopButton.FlatAppearance.BorderSize = 0; stopButton.TabStop = false;
    stopButton.Click += delegate { Stop("button"); };
    Controls.Add(dot); Controls.Add(label); Controls.Add(stopButton);
  }
  protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); try { SetWindowDisplayAffinity(Handle, 0x11); } catch { } }
  void Stop(string why) {
    if (stopped) return; stopped = true;
    Console.Out.WriteLine("STOP " + why); Console.Out.Flush();
    label.Text = stoppedText; stopButton.Enabled = false;
    var t = new System.Windows.Forms.Timer(); t.Interval = 1500; t.Tick += delegate { Application.Exit(); }; t.Start();
  }
  void SetLabel(string text) { if (!stopped) label.Text = text; }
  static IntPtr Hook(int code, IntPtr w, IntPtr l) {
    int msg = w.ToInt32();
    if (code >= 0 && (msg == 0x100 || msg == 0x104)) {
      int vk = Marshal.ReadInt32(l); int flags = Marshal.ReadInt32(l, 8);
      if (vk == 0x1B && (flags & 0x10) == 0 && bar != null) { try { bar.BeginInvoke(new MethodInvoker(delegate { bar.Stop("esc"); })); } catch { } }
    }
    return CallNextHookEx(hook, code, w, l);
  }
  public static void Run(string text, string stopText, string stoppedText) {
    try { SetProcessDPIAware(); } catch { }
    Console.OutputEncoding = new System.Text.UTF8Encoding(false);
    Application.EnableVisualStyles();
    bar = new CudeBar(text, stopText, stoppedText);
    proc = new HookProc(Hook); hook = SetWindowsHookEx(13, proc, GetModuleHandle(null), 0);
    var reader = new Thread(delegate () {
      var input = new System.IO.StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false));
      string line;
      while ((line = input.ReadLine()) != null) {
        string value = line;
        if (value.StartsWith("label ")) { try { bar.BeginInvoke(new MethodInvoker(delegate { bar.SetLabel(value.Substring(6)); })); } catch { } }
        if (value == "show") { try { bar.BeginInvoke(new MethodInvoker(delegate { bar.Show(); })); } catch { } }
        if (value == "hide") { try { bar.BeginInvoke(new MethodInvoker(delegate { bar.Hide(); })); } catch { } }
      }
      try { bar.BeginInvoke(new MethodInvoker(delegate { Application.Exit(); })); } catch { }
    });
    reader.IsBackground = true; reader.Start();
    Console.Out.WriteLine("READY"); Console.Out.Flush();
    Application.Run(bar);
    if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
  }
}
`;

const LOADER_PS1 = String.raw`param([string]$Source, [string]$Dll, [string]$Refs, [string]$Entry)
$ErrorActionPreference = 'Stop'
$names = $Refs -split ','
foreach ($n in $names) { Add-Type -AssemblyName $n }
if (-not (Test-Path -LiteralPath $Dll)) {
  $locations = [AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $names -contains $_.GetName().Name } | ForEach-Object { $_.Location }
  $tmp = $Dll + '.' + $PID + '.tmp'
  Add-Type -TypeDefinition ([IO.File]::ReadAllText($Source)) -ReferencedAssemblies $locations -OutputAssembly $tmp -OutputType Library
  try { Move-Item -LiteralPath $tmp -Destination $Dll -Force } catch { if (-not (Test-Path -LiteralPath $Dll)) { throw } }
  Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
}
Add-Type -LiteralPath $Dll
Invoke-Expression $Entry
`;

/** Writes (once) the helper sources next to a cached compiled DLL keyed by the source hash. */
function helperFiles(name: string, source: string) {
  const hash = createHash('sha256').update(source).update(LOADER_PS1).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), `cude-computer-${hash}`);
  fs.mkdirSync(dir, { recursive: true });
  const cs = path.join(dir, `${name}.cs`), loader = path.join(dir, 'loader.ps1');
  if (!fs.existsSync(cs)) fs.writeFileSync(cs, source, 'utf8');
  if (!fs.existsSync(loader)) fs.writeFileSync(loader, '\ufeff' + LOADER_PS1, 'utf8');
  return { cs, loader, dll: path.join(dir, `${name}.dll`) };
}
function powershell() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell.exe';
}

export class WindowsDriver implements ComputerDriver {
  private child: ChildProcess | undefined;
  private buffer = '';
  private seq = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stderr = '';

  private start() {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const files = helperFiles('CudeComputer', HELPER_CS);
    const child = spawn(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-MTA', '-File', files.loader,
      '-Source', files.cs, '-Dll', files.dll, '-Refs', 'UIAutomationClient,UIAutomationTypes,System.Drawing,System.Windows.Forms,System.Web.Extensions,WindowsBase', '-Entry', '[CudeComputer]::Run()'],
    { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child; this.buffer = ''; this.stderr = '';
    child.stdin!.on('error', () => { });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      let i: number;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).trim(); this.buffer = this.buffer.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const msg = JSON.parse(line); const wait = this.waiting.get(Number(msg.id));
          if (!wait) continue;
          this.waiting.delete(Number(msg.id)); clearTimeout(wait.timer);
          if (msg.ok) wait.resolve(msg.result); else wait.reject(new Error(String(msg.error || 'helper error')));
        } catch { }
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    const fail = (why: string) => { for (const [id, wait] of this.waiting) { clearTimeout(wait.timer); wait.reject(new Error(why)); this.waiting.delete(id); } if (this.child === child) this.child = undefined; };
    child.on('exit', code => fail(`helper exited (${code})${this.stderr ? ': ' + this.stderr.trim().slice(-400) : ''}`));
    child.on('error', error => fail(`helper could not start: ${error.message}`));
    return child;
  }

  call<T = any>(op: string, args: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> {
    if (process.platform !== 'win32') return Promise.reject(new Error('UNSUPPORTED_PLATFORM'));
    const child = this.start();
    const id = ++this.seq;
    // The first call also compiles the helper (a few seconds, cached afterwards).
    const limit = this.seq === 1 ? Math.max(timeoutMs, 60000) : timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`helper timeout (${op})`)); }, limit);
      timer.unref?.();
      this.waiting.set(id, { resolve, reject, timer });
      try { child.stdin!.write(JSON.stringify({ id, op, args }) + '\n'); }
      catch (err: any) { clearTimeout(timer); this.waiting.delete(id); reject(err instanceof Error ? err : new Error(String(err))); }
    });
  }

  dispose() {
    const child = this.child; this.child = undefined;
    for (const [id, wait] of this.waiting) { clearTimeout(wait.timer); wait.reject(new Error('STOPPED')); this.waiting.delete(id); }
    try { child?.stdin?.end(); } catch { }
    try { child?.kill(); } catch { }
  }
}

/** Topmost, non-activating bar ("Cude is using the screen" + Stop). Esc (real key presses only) also stops. */
export class WindowsActivityBar implements ActivityBar {
  private child: ChildProcess | undefined;
  constructor(private texts: () => { label: string; stop: string; stopped: string }, private onStop: (why: string) => void) {}
  get pid() { return this.child?.pid; }
  show(label: string) {
    if (process.platform !== 'win32') return;
    if (!this.child || this.child.exitCode !== null || this.child.killed) {
      const t = this.texts();
      const files = helperFiles('CudeBar', BAR_CS);
      const child = spawn(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', files.loader,
        '-Source', files.cs, '-Dll', files.dll, '-Refs', 'System.Windows.Forms,System.Drawing', '-Entry', '[CudeBar]::Run($env:CUDE_BAR_TEXT, $env:CUDE_BAR_STOP, $env:CUDE_BAR_STOPPED)'],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, CUDE_BAR_TEXT: label || t.label, CUDE_BAR_STOP: t.stop, CUDE_BAR_STOPPED: t.stopped } });
      this.child = child;
      child.stdin!.on('error', () => { });
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => { const m = /STOP (\w+)/.exec(chunk); if (m) this.onStop(m[1]); });
      child.on('exit', () => { if (this.child === child) this.child = undefined; });
      child.on('error', () => { if (this.child === child) this.child = undefined; });
      return;
    }
    try { this.child.stdin!.write(`label ${String(label).replace(/[\r\n]+/g, ' ')}\nshow\n`); } catch { }
  }
  hide() { const child = this.child; this.child = undefined; try { child?.stdin?.end(); } catch { } setTimeout(() => { try { child?.kill(); } catch { } }, 500).unref?.(); }
  dispose() { const child = this.child; this.child = undefined; try { child?.stdin?.end(); } catch { } try { child?.kill(); } catch { } }
}

/** Extracts "[image: path]" markers strictly inside Cude's own temp shot folders (no UNC, traversal, or symlinks escaping out). */
export function extractImagePaths(observation: string): string[] {
  const roots = [path.join(os.tmpdir(), 'cude-computer'), path.join(os.tmpdir(), 'cude-browser')].map(p => {
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
  });
  const norm = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
  const out: string[] = [];
  for (const m of String(observation).matchAll(/\[image: ([^\]\r\n]+\.png)\]/g)) {
    const raw = m[1].trim();
    if (!raw || /^(\\\\|\/\/)/.test(raw)) continue;
    const candidate = path.resolve(raw);
    if (/^(\\\\|\/\/)/.test(candidate)) continue;
    try {
      const real = fs.realpathSync(candidate);
      if (/^(\\\\|\/\/)/.test(real)) continue;
      if (!fs.statSync(real).isFile()) continue;
      const realNorm = norm(real);
      if (roots.some(r => realNorm.startsWith(norm(r) + path.sep))) out.push(real);
    } catch { }
  }
  return out;
}
