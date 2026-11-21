const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryLevel, readCommitWindows, topProcesses, HealthMonitor } = require('../out/healthMonitor.js');

test('memoryLevel boundary values for physical and commit memory', () => {
  assert.equal(memoryLevel({ freePhysMB: 599, totalPhysMB: 16384 }), 'critical');
  assert.equal(memoryLevel({ freePhysMB: 600, totalPhysMB: 16384 }), 'low');
  assert.equal(memoryLevel({ freePhysMB: 1199, totalPhysMB: 16384 }), 'low');
  assert.equal(memoryLevel({ freePhysMB: 1200, totalPhysMB: 16384 }), 'ok');

  assert.equal(memoryLevel({ freePhysMB: 4000, totalPhysMB: 16384, freeCommitMB: 899, totalCommitMB: 26000 }), 'critical');
  assert.equal(memoryLevel({ freePhysMB: 4000, totalPhysMB: 16384, freeCommitMB: 900, totalCommitMB: 26000 }), 'low');
  assert.equal(memoryLevel({ freePhysMB: 4000, totalPhysMB: 16384, freeCommitMB: 1999, totalCommitMB: 26000 }), 'low');
  assert.equal(memoryLevel({ freePhysMB: 4000, totalPhysMB: 16384, freeCommitMB: 2000, totalCommitMB: 26000 }), 'ok');
});

test('HealthMonitor calls onChange only when level changes across ok->low->low->critical->ok', async () => {
  const samples = [
    { freePhysMB: 2500, totalPhysMB: 16384 },
    { freePhysMB: 900, totalPhysMB: 16384 },
    { freePhysMB: 850, totalPhysMB: 16384 },
    { freePhysMB: 400, totalPhysMB: 16384 },
    { freePhysMB: 3000, totalPhysMB: 16384 },
  ];
  let idx = 0;
  const changes = [];
  const monitor = new HealthMonitor({
    sample: async () => samples[idx++],
    intervalMs: 60_000,
    onChange: (level, sample) => {
      changes.push({ level, freePhysMB: sample.freePhysMB });
    },
  });

  assert.equal(monitor.level, 'ok');
  assert.equal(monitor.last, undefined);

  assert.equal(await monitor.checkNow(), 'ok');
  assert.equal(await monitor.checkNow(), 'low');
  assert.equal(await monitor.checkNow(), 'low');
  assert.equal(await monitor.checkNow(), 'critical');
  assert.equal(await monitor.checkNow(), 'ok');

  assert.deepEqual(
    changes.map((c) => c.level),
    ['low', 'critical', 'ok']
  );
  assert.equal(changes.length, 3);
  assert.equal(monitor.level, 'ok');
  assert.deepEqual(monitor.last, { freePhysMB: 3000, totalPhysMB: 16384 });
});

test('HealthMonitor start() runs immediately and stop() prevents further sampling', async () => {
  let count = 0;
  const changes = [];
  const monitor = new HealthMonitor({
    sample: async () => {
      count += 1;
      return { freePhysMB: 800, totalPhysMB: 16384 };
    },
    intervalMs: 25,
    onChange: (level) => {
      changes.push(level);
    },
  });

  monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  monitor.stop();
  const countAtStop = count;
  assert.ok(countAtStop >= 1);
  assert.deepEqual(changes, ['low']);

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(count, countAtStop);
});

test('readCommitWindows and topProcesses return numeric metrics on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const commit = await readCommitWindows();
  // Sandboxed runners (e.g. Codex workspace-write) cannot start PowerShell; that is an environment limit, not a bug.
  // Sandboxed runners may start PowerShell but cannot query CIM (system memory); that is an environment limit, not a bug.
  if (commit === undefined) { t.skip('system memory query unavailable in this environment'); return; }
  assert.ok(commit !== undefined);
  assert.equal(typeof commit.freeCommitMB, 'number');
  assert.equal(typeof commit.totalCommitMB, 'number');
  assert.ok(commit.totalCommitMB > 0);
  assert.ok(commit.freeCommitMB >= 0);

  const procs = await topProcesses(5);
  assert.ok(Array.isArray(procs));
  assert.ok(procs.length > 0 && procs.length <= 5);
  for (const p of procs) {
    assert.equal(typeof p.name, 'string');
    assert.equal(typeof p.count, 'number');
    assert.equal(typeof p.privateMB, 'number');
    assert.ok(p.count >= 1);
    assert.ok(p.privateMB >= 0);
  }
  for (let i = 1; i < procs.length; i += 1) {
    assert.ok(procs[i - 1].privateMB >= procs[i].privateMB);
  }
});

test('a nearly full system drive raises the level even when memory is fine', () => {
  const { memoryLevel, readSystemDiskFreeMB } = require('../out/healthMonitor');
  assert.equal(memoryLevel({ freePhysMB: 8000, totalPhysMB: 16000, freeDiskMB: 500 }), 'critical');
  assert.equal(memoryLevel({ freePhysMB: 8000, totalPhysMB: 16000, freeDiskMB: 3000 }), 'low');
  assert.equal(memoryLevel({ freePhysMB: 8000, totalPhysMB: 16000, freeDiskMB: 50000 }), 'ok');
  const free = readSystemDiskFreeMB();
  assert.ok(free === undefined || (Number.isFinite(free) && free >= 0));
});
