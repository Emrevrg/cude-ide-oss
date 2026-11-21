const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const cu = require('../out/computerUse.js');
const bc = require('../out/browserControl.js');

const rules = { selfProcesses: ['cudeide'], browserPids: new Set([4242]), allowedApps: [] };

test('target refusals: lock screen, elevated, self, protected, user browser, allow list', () => {
  assert.equal(cu.targetRefusal({ process: 'notepad', locked: true }, rules), 'locked');
  assert.equal(cu.targetRefusal({ process: 'regedit', elevated: true }, rules), 'elevated');
  assert.equal(cu.targetRefusal({ process: 'CudeIDE.exe' }, rules), 'self');
  assert.equal(cu.targetRefusal({ process: 'LogonUI' }, rules), 'protected');
  assert.equal(cu.targetRefusal({ process: 'chrome', pid: 1 }, rules), 'user-browser');
  assert.equal(cu.targetRefusal({ process: 'chrome', pid: 4242 }, rules), undefined, 'the isolated Cude browser is allowed');
  assert.equal(cu.targetRefusal({ process: 'notepad' }, rules), undefined);
  assert.equal(cu.targetRefusal({ process: 'excel' }, { ...rules, allowedApps: ['notepad.exe'] }), 'not-allowed');
  assert.equal(cu.targetRefusal(undefined, rules), 'unknown');
});

test('never types passwords or card numbers', () => {
  assert.equal(cu.typingRefusal('hunter2', { password: true }), 'password');
  assert.equal(cu.typingRefusal('x', { name: 'Parola' }), 'password');
  assert.equal(cu.typingRefusal('4111 1111 1111 1111'), 'card');
  assert.equal(cu.typingRefusal('merhaba', { name: 'Metin' }), undefined);
  assert.equal(cu.looksLikeCardNumber('1234 5678 9012 3456'), false, 'Luhn check fails');
  assert.equal(bc.fieldRefusal({ type: 'password' }, 'abc'), 'password');
  assert.ok(bc.fieldRefusal({ autocomplete: 'cc-number' }, '4111111111111111'), 'card field refused');
  assert.equal(bc.fieldRefusal({ type: 'text', name: 'q' }, 'cude ide'), undefined);
});

test('browser uses an isolated profile, never the user profile; only http(s) urls', () => {
  const env = { ...process.env, LOCALAPPDATA: path.join(os.homedir(), 'AppData', 'Local') };
  assert.equal(bc.isIsolatedProfile(bc.defaultProfileDir(env), env), true);
  assert.equal(bc.isIsolatedProfile(path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data'), env), false);
  assert.equal(bc.isIsolatedProfile(os.homedir(), env), false);
  assert.ok(bc.safeUrl('https://example.com'));
  assert.equal(bc.safeUrl('file:///C:/Windows/win.ini'), undefined);
  assert.equal(bc.safeUrl('javascript:alert(1)'), undefined);
});

function fakeDriver(log) {
  const win = { id: 7, process: 'notepad', title: 'Adsız - Not Defteri', pid: 99, x: 0, y: 0, width: 800, height: 600, foreground: true };
  return {
    async call(op, args) {
      log.push(op);
      if (op === 'windows') return [win];
      if (op === 'locked') return false;
      if (op === 'target') return { ...win, elementName: 'Metin Düzenleyicisi', pointX: 10, pointY: 10, password: args?.element === 'pw' };
      if (op === 'focus') return true;
      if (op === 'uitree') return [{ id: 'e1', type: 'Edit', name: 'Metin', x: 0, y: 0, width: 10, height: 10 }];
      return true;
    },
    dispose() { log.push('dispose'); },
  };
}

test('no action without approval; session grant per app; stop ends everything', async () => {
  if (process.platform !== 'win32') return;
  const log = []; let answer = 'deny'; const asked = [];
  const c = new cu.ComputerUse({ driver: fakeDriver(log), approver: async r => { asked.push(r.kind); return answer; }, settings: () => ({ enabled: true, allowedApps: [] }), language: () => 'en' });
  let out = await c.typeText({ text: 'merhaba', window: 'notepad' });
  assert.match(out, /declined/);
  assert.ok(!log.includes('type'), 'nothing typed when declined');
  answer = 'session';
  out = await c.typeText({ text: 'merhaba', window: 'notepad' });
  assert.match(out, /Typed 7 characters/);
  answer = 'deny';
  out = await c.typeText({ text: 'tekrar', window: 'notepad' });
  assert.match(out, /Typed 6/, 'session grant for notepad is reused');
  out = await c.typeText({ text: 'secret', element: 'pw' });
  assert.match(out, /password/i);
  c.stop();
  out = await c.typeText({ text: 'x', window: 'notepad' });
  assert.match(out, /stopped/i);
  assert.ok(log.includes('dispose'));
});

test('disabled computer use refuses before touching the driver', async () => {
  if (process.platform !== 'win32') return;
  const log = [];
  const c = new cu.ComputerUse({ driver: fakeDriver(log), approver: async () => 'once', settings: () => ({ enabled: false, allowedApps: [] }) });
  assert.match(await c.listWindows(), /turned off/);
  assert.match(await c.click({ x: 1, y: 1 }), /turned off/);
  assert.deepEqual(log, []);
});

test('coordinate clicks need a fresh look first', async () => {
  if (process.platform !== 'win32') return;
  const log = [];
  const c = new cu.ComputerUse({ driver: fakeDriver(log), approver: async () => 'once', settings: () => ({ enabled: true, allowedApps: [] }) });
  assert.match(await c.click({ x: 5, y: 5 }), /fresh screenshot/);
  assert.ok(!log.includes('click'));
});
