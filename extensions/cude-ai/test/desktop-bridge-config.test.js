const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const { parse } = require('jsonc-parser');
const YAML = require('yaml');
const { bridgeConfigText, bridgeConfigured, writeBridgeConfig } = require('../out/desktopBridgeConfig');
const load = Module._load;
let targets, mcpTargets;
try {
  Module._load = function(id, ...args) { return id === 'vscode' ? {} : load.call(this, id, ...args); };
  ({ targets, mcpTargets } = require('../out/desktopBridge'));
} finally { Module._load = load; }
const entry = { command: 'C:\\Cude IDE\\Cude.exe', args: ['C:\\Cude IDE\\media\\bridge\\cude-mcp.js'], env: { ELECTRON_RUN_AS_NODE: '1' } };

for (const id of ['zed', 'kiro', 'continue', 'trae', 'void', 'opencode', 'vscode']) {
  test(`${id}: actual target writes, reads, backs up exact bytes and reconnects without duplicate servers`, async () => {
    const home = await fs.mkdtemp(path.join(process.cwd(), 'dist', 'mcp-config-'));
    try {
      const appData = path.join(home, 'appdata');
      const target = targets(home, appData, 'win32').find(t => t.id === id);
      assert.ok(target.file.startsWith(home + path.sep));
      const key = target.key ?? 'mcpServers';
      const before = id === 'continue'
        ? '# preserve yaml comment\r\nname: Existing\r\nversion: 2.0.0\r\nschema: v1\r\nmodels: []\r\nmcpServers:\r\n  - name: other\r\n    command: other-command\r\n'
        : `{// preserve json comment\r\n"unrelated": {"keep":true}, "${key}": {"other":{"command":"other-command"}},\r\n}`;
      await fs.mkdir(path.dirname(target.file), { recursive: true });
      await fs.writeFile(target.file, before);
      assert.equal(mcpTargets(home, appData, 'win32').find(t => t.id === id).connected, false);
      await writeBridgeConfig(target, entry);
      const after = await fs.readFile(target.file, 'utf8');
      assert.equal(await fs.readFile(target.file + '.cude-backup', 'utf8'), before);
      assert.match(after, /preserve (yaml|json) comment/);
      const config = id === 'continue' ? YAML.parse(after) : parse(after);
      const added = id === 'continue' ? config.mcpServers.find(s => s.name === 'cude-ide') : config[key]['cude-ide'];
      if (id === 'continue') {
        assert.equal(config.name, 'Existing'); assert.deepEqual(config.models, []);
        assert.equal(config.mcpServers[0].command, 'other-command');
        assert.deepEqual(added, { name: 'cude-ide', ...entry });
      } else {
        assert.deepEqual(config.unrelated, { keep: true });
        assert.equal(config[key].other.command, 'other-command');
        if (id === 'opencode') assert.deepEqual(added, { type: 'local', command: [entry.command, ...entry.args], environment: entry.env, enabled: true, timeout: 30000 });
        else assert.deepEqual(added, id === 'vscode' ? { type: 'stdio', ...entry } : entry);
      }
      assert.equal(bridgeConfigured(target, after), true);
      const status = mcpTargets(home, appData, 'win32').find(t => t.id === id);
      assert.equal(status.installed, true); assert.equal(status.connected, true);
      await writeBridgeConfig(target, entry);
      assert.equal(await fs.readFile(target.file, 'utf8'), after);
      assert.equal(await fs.readFile(target.file + '.cude-backup', 'utf8'), before);
      const replacement = { ...entry, args: ['updated.js'] };
      await writeBridgeConfig(target, replacement);
      assert.equal(await fs.readFile(target.file + '.cude-backup', 'utf8'), after);
      const updated = await fs.readFile(target.file, 'utf8');
      assert.equal((updated.match(/cude-ide/g) || []).length, 1);
      assert.ok(updated.includes('updated.js'));
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });
}

test('new target files can be created in an empty home; platform paths and absent detection are correct', async () => {
  const home = await fs.mkdtemp(path.join(process.cwd(), 'dist', 'mcp-new-'));
  try {
    const appData = path.join(home, 'appdata');
    for (const platform of ['win32', 'darwin', 'linux']) {
      const rows = targets(home, appData, platform);
      assert.equal(rows.find(t => t.id === 'zed').file, platform === 'win32' ? path.join(appData, 'Zed', 'settings.json') : path.join(home, '.config', 'zed', 'settings.json'));
      assert.ok(!rows.some(t => t.file.includes('.codex')));
    }
    const statuses = mcpTargets(home, appData, 'win32');
    for (const id of ['zed', 'kiro', 'continue', 'trae', 'void']) {
      assert.equal(statuses.find(t => t.id === id).installed, false);
      const target = targets(home, appData, 'win32').find(t => t.id === id);
      await writeBridgeConfig(target, entry);
      assert.equal(bridgeConfigured(target, await fs.readFile(target.file, 'utf8')), true);
      await assert.rejects(fs.access(target.file + '.cude-backup'), { code: 'ENOENT' });
    }
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('malformed JSON/YAML and wrong server collection types leave config and existing backup untouched', async () => {
  const home = await fs.mkdtemp(path.join(process.cwd(), 'dist', 'mcp-invalid-'));
  try {
    for (const [schema, text] of [[undefined, '{broken'], [undefined, '[]'], [undefined, '{"mcpServers":[]}'], ['continue', 'models: [broken'], ['continue', 'mcpServers: {}'], ['continue', 'a: &a [1]\nmcpServers: *a'], ['continue', 'mcpServers: []\nmcpServers: []']]) {
      const target = { id: 'fixture', label: 'Fixture', file: path.join(home, 'config'), schema };
      await fs.writeFile(target.file, text); await fs.writeFile(target.file + '.cude-backup', 'previous backup');
      await assert.rejects(writeBridgeConfig(target, entry));
      assert.equal(await fs.readFile(target.file, 'utf8'), text);
      assert.equal(await fs.readFile(target.file + '.cude-backup', 'utf8'), 'previous backup');
    }
    assert.equal(bridgeConfigured({ key: 'context_servers' }, '{"context_servers":{"cude-ide":{"command":"x","enabled":false}}}'), false);
    const target = { schema: 'continue' };
    const text = bridgeConfigText(target, 'mcpServers:\n - name: cude-ide\n   command: old\n - name: cude-ide\n   command: stale\n', entry);
    assert.equal(YAML.parse(text).mcpServers.length, 1);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
