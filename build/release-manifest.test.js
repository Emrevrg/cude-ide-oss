'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepare, verify } = require('./release-manifest');
const { stagePages } = require('./stage-pages-update');

test('Pages staging keeps the signed update pair together and rejects changed bytes or a different origin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cude-pages-'));
  try {
    const feed = 'https://emrevrg.github.io/cude-ide-releases/update/manifest.json';
    const name = 'Cude-IDE-0.1.1-win32-x64.zip';
    const archive = path.join(dir, name), manifestPath = path.join(dir, 'manifest.json');
    const trustPath = path.join(dir, 'trust.json'), index = path.join(dir, 'index.html');
    const keys = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(archive, 'archive fixture');
    fs.writeFileSync(index, '<h1>Cude IDE</h1>');
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'fixture.txt'), 'asset');
    fs.writeFileSync(trustPath, JSON.stringify({feed,key:keys.publicKey.export({ type:'spki',format:'pem' })}));
    const sign = url => prepare({ file:archive, url, version:'0.1.1', minimum:'0.1.0',
      sequence:1, privateKey:keys.privateKey.export({ type:'pkcs8',format:'pem' }) });
    const signed = await sign(new URL(name,feed).href);
    fs.writeFileSync(manifestPath, JSON.stringify(signed));
    const stage = output => stagePages({ archive, manifestPath, trustPath, website:dir, index, output:path.join(dir,output) });
    const report = await stage('site');
    assert.equal(report.sha256,signed.manifest.sha256);
    assert.deepEqual(fs.readFileSync(path.join(dir,'site','update',name)),fs.readFileSync(archive));
    assert.deepEqual(fs.readFileSync(path.join(dir,'site','update','manifest.json')),fs.readFileSync(manifestPath));
    assert.equal(fs.readFileSync(path.join(dir,'site','assets','fixture.txt'),'utf8'),'asset');
    fs.writeFileSync(manifestPath, JSON.stringify(await sign(`https://example.invalid/${name}`)));
    await assert.rejects(stage('wrong-origin'),/Pages update directory/);
    fs.writeFileSync(manifestPath, JSON.stringify(signed));
    fs.writeFileSync(archive, 'archive changed');
    await assert.rejects(stage('wrong-bytes'),/signed SHA-256/);
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('signed releases reject edited manifests, altered archives, wrong origins, rollback and expiry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cude-release-'));
  try {
    const file = path.join(dir, 'package.zip'), origin = 'https://release.example.test';
    fs.writeFileSync(file, 'fixture archive');
    const key = crypto.generateKeyPairSync('ed25519');
    const privateKey = key.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' });
    const now = Date.UTC(2026, 10, 19);
    const envelope = await prepare({ file, url: origin + '/Cude-IDE-0.1.0-win32-x64.zip', version: '0.1.0',
      minimum: '0.1.0', sequence: 5, privateKey, now });
    const checks = { file, envelope, publicKey, origin, minSequence: 5, now };
    assert.equal((await verify(checks)).sequence, 5);
    await assert.rejects(verify({ ...checks, envelope: { ...envelope, manifest: { ...envelope.manifest, sequence: 6 } } }), /signature/);
    await assert.rejects(verify({ ...checks, origin: 'https://mirror.example.test' }), /origin/);
    await assert.rejects(verify({ ...checks, minSequence: 6 }), /older/);
    await assert.rejects(verify({ ...checks, now: now + 15 * 86400000 }), /validity/);
    fs.writeFileSync(file, 'altered archive');
    await assert.rejects(verify(checks), /digest/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
