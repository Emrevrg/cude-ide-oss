'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const PS = (() => { const r = require('node:child_process').spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }); return r.status === 0 ? 'pwsh' : 'powershell'; })();
test('portable packaging excludes profiles, rejects credentials and links, and preserves an existing package on failure', () => {
  const temporaryRoot = path.resolve(process.env.CUDE_TEST_TMP || os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'cude-pack-security-'));
  const work = path.join(root, 'dist', 'Cude-IDE');
  const archive = path.join(root, 'dist', 'Cude-IDE-0.1.0-win32-x64.zip');
  const app = 'resources/app/extensions/cude-ai/out/extension.js';
  const write = (relative, text) => {
    const target = path.join(work, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    return target;
  };
  const run = (...args) => spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'paketle.ps1'), '-Root', root, ...args], { encoding:'utf8' });
  try {
    write('CudeIDE.exe', 'fixture');
    write(app, 'console.log("fixture");');
    write('resources/app/extensions/cude-ai/package.json', JSON.stringify({version:'0.1.0'}));
    write('data/PORTABLE.txt', 'Cude portable test marker');
    write('data/user-data/settings.json', 'private-user-fixture');
    write('gateway/.env', 'private-gateway-fixture');
    const validation = run('-ValidateOnly');
    assert.equal(validation.status, 0, validation.stderr);
    assert.equal(fs.existsSync(archive), false);
    const packaged = run();
    assert.equal(packaged.status, 0, packaged.stderr);
    const before = fs.readFileSync(archive);
    assert.doesNotMatch(before.toString('latin1'), /user-data|gateway\/\.env/);
    const fake = 'nvapi-' + 'Z'.repeat(42);
    write(app, 'const env = "' + fake + '";');
    const rejected = run();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /possible credential/);
    assert.ok(!rejected.stderr.includes(fake));
    assert.deepEqual(fs.readFileSync(archive), before);
    assert.equal(fs.readdirSync(path.dirname(archive)).some(name => name.endsWith('.tmp')), false);
    write(app, ['-----BEGIN PRIVATE KEY-----','R'.repeat(64),'-----END PRIVATE KEY-----'].join('\n'));
    assert.match(run('-ValidateOnly').stderr, /possible credential/);
    write(app, 'console.log("fixture");');
    const env = write('.env.local', 'fixture=non-secret');
    assert.match(run('-ValidateOnly').stderr, /sensitive file name/);
    fs.unlinkSync(env);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(work, 'linked'), 'junction');
    assert.match(run('-ValidateOnly').stderr, /link or junction/);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), temporaryRoot);
    fs.rmSync(root, { recursive:true, force:true });
  }
});
