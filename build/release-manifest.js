'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const versionPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const day = 86_400_000;
const bytes = value => Buffer.from(JSON.stringify(value), 'utf8');

function versionAtLeast(version, minimum) {
  const a = version.split('.').map(Number), b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    size += chunk.length;
    hash.update(chunk);
  }
  if (!size) throw new Error('The release archive is empty.');
  return { size, sha256: hash.digest('hex') };
}

function validate(manifest, expectedOrigin, minSequence, now = Date.now()) {
  if (manifest?.schema !== 1 || manifest.platform !== 'win32-x64' ||
      !versionPattern.test(manifest.version || '') || !versionPattern.test(manifest.minPoolVersion || '') ||
      !versionAtLeast(manifest.version, manifest.minPoolVersion) ||
      !Number.isSafeInteger(manifest.sequence) || manifest.sequence < Math.max(1, minSequence) ||
      !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || !/^[0-9a-f]{64}$/.test(manifest.sha256 || '')) {
    throw new Error('Invalid release metadata or older release sequence.');
  }
  if (!Number.isSafeInteger(manifest.issuedAt) || !Number.isSafeInteger(manifest.expiresAt) ||
      manifest.issuedAt > now + 300_000 || manifest.expiresAt <= now ||
      manifest.expiresAt <= manifest.issuedAt || manifest.expiresAt - manifest.issuedAt > 30 * day) {
    throw new Error('The release manifest is outside its validity period.');
  }
  if ((manifest.minimumVersion !== undefined && (!versionPattern.test(manifest.minimumVersion) || !versionAtLeast(manifest.version,manifest.minimumVersion))) ||
      (manifest.mandatory !== undefined && typeof manifest.mandatory !== 'boolean') ||
      (manifest.notes !== undefined && (typeof manifest.notes !== 'string' || manifest.notes.length > 4000))) throw new Error('Invalid update policy.');
  const url = new URL(manifest.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (expectedOrigin && url.origin !== expectedOrigin) ||
      !url.pathname.endsWith('/Cude-IDE-' + manifest.version + '-win32-x64.zip')) {
    throw new Error('The archive URL does not match the release origin and version.');
  }
}

async function prepare({ file, url, version, minimum, sequence, privateKey, minimumVersion, mandatory, notes, now = Date.now() }) {
  const key = crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 private key is required.');
  const { size, sha256 } = await hashFile(file);
  const manifest = { schema: 1, platform: 'win32-x64', version, minPoolVersion: minimum, sequence,
    url, size, sha256, issuedAt: now, expiresAt: now + 14 * day };
  if (minimumVersion !== undefined) manifest.minimumVersion = minimumVersion;
  if (mandatory !== undefined) manifest.mandatory = mandatory;
  if (notes !== undefined) manifest.notes = notes;
  validate(manifest, undefined, 1, now);
  return { manifest, signature: crypto.sign(null, bytes(manifest), key).toString('base64') };
}

async function verify({ envelope, publicKey, origin, minSequence, file, now = Date.now() }) {
  if (!origin || !Number.isSafeInteger(minSequence) || minSequence < 1) throw new Error('A trusted release origin and sequence are required.');
  const key = crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || typeof envelope?.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature) ||
      !crypto.verify(null, bytes(envelope.manifest), key, Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('The release signature is invalid.');
  }
  validate(envelope.manifest, origin, minSequence, now);
  const actual = await hashFile(file);
  if (actual.size !== envelope.manifest.size || actual.sha256 !== envelope.manifest.sha256) throw new Error('The archive digest does not match.');
  return envelope.manifest;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'prepare' && args.length === 7) {
    const [file, url, version, minimum, sequence, keyFile, output] = args;
    const envelope = await prepare({ file, url, version, minimum, sequence: Number(sequence), privateKey: fs.readFileSync(keyFile) });
    fs.writeFileSync(output, JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx' });
    console.log('Signed release manifest written: ' + path.resolve(output));
    return;
  }
  if (mode === 'verify' && args.length === 5) {
    const [file, manifest, keyFile, origin, minSequence] = args;
    if (fs.statSync(manifest).size > 16_384) throw new Error('The release manifest is too large.');
    const envelope = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const result = await verify({ file, envelope, publicKey: fs.readFileSync(keyFile), origin, minSequence: Number(minSequence) });
    console.log('Verified release ' + result.version + ' (sequence ' + result.sequence + ').');
    return;
  }
  throw new Error('Usage: release-manifest.js prepare <zip> <https-url> <version> <min-pool-version> <sequence> <private-pem> <output> | verify <zip> <manifest> <public-pem> <https-origin> <min-sequence>');
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { prepare, verify };
