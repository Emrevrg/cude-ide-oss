'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, createPublicKey, verify } = require('node:crypto');

const MAX_SITE = 1_000_000_000;
const VERSION = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
const FEED = 'https://emrevrg.github.io/cude-ide-releases/update/manifest.json';

async function validateUpdate(archive, manifestPath, trustPath) {
  const trust = JSON.parse(await fsp.readFile(trustPath, 'utf8'));
  const bytes = await fsp.readFile(manifestPath);
  if (bytes.length > 16_384 || trust.feed !== FEED) throw Error('Invalid Pages update feed');
  const { manifest, signature } = JSON.parse(bytes);
  const publicKey = createPublicKey(trust.key);
  if (!manifest || !signature || typeof signature !== 'string' || publicKey.asymmetricKeyType !== 'ed25519' ||
      !/^[A-Za-z0-9+/]{86}==$/.test(signature) ||
      !verify(null, Buffer.from(JSON.stringify(manifest)), publicKey, Buffer.from(signature, 'base64'))) {
    throw Error('Pages update signature does not match the trusted key');
  }
  const archiveName = `Cude-IDE-${manifest.version}-win32-x64.zip`;
  if (!VERSION.test(manifest.version) || manifest.schema !== 1 || manifest.platform !== 'win32-x64' ||
      manifest.url !== new URL(archiveName, FEED).href || path.basename(archive) !== archiveName ||
      !Number.isSafeInteger(manifest.issuedAt) || !Number.isSafeInteger(manifest.expiresAt) ||
      manifest.issuedAt > Date.now() + 300_000 || manifest.expiresAt <= Date.now() || manifest.expiresAt <= manifest.issuedAt ||
      manifest.expiresAt - manifest.issuedAt > 30 * 86_400_000) {
    throw Error('Manifest must name a valid release under the Pages update directory');
  }
  const stat = await fsp.lstat(archive);
  if (!stat.isFile() || stat.size < 1 || stat.size !== manifest.size || stat.size > MAX_SITE) throw Error('Pages archive size differs from the signed size');
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== manifest.sha256) throw Error('Pages archive hash differs from the signed SHA-256');
  return { archiveName, manifest };
}

async function siteBytes(directory) {
  let total = 0;
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await siteBytes(file);
    else if (entry.isFile() && !entry.isSymbolicLink()) total += (await fsp.stat(file)).size;
    else throw Error('Pages artifact contains a link or unsupported entry');
  }
  return total;
}

async function stagePages({ archive, manifestPath, trustPath, website, index, output }) {
  const { archiveName, manifest } = await validateUpdate(archive, manifestPath, trustPath);
  await fsp.mkdir(output);
  await fsp.copyFile(index, path.join(output, 'index.html'));
  await fsp.writeFile(path.join(output, '.nojekyll'), '');
  await fsp.cp(path.join(website, 'assets'), path.join(output, 'assets'), { recursive: true });
  const update = path.join(output, 'update');
  await fsp.mkdir(update);
  await fsp.copyFile(manifestPath, path.join(update, 'manifest.json'));
  await fsp.copyFile(archive, path.join(update, archiveName));
  const size = await siteBytes(output);
  if (size > MAX_SITE) throw Error('Pages site exceeds 1 GB');
  return { url: manifest.url, zipBytes: manifest.size, siteBytes: size, sha256: manifest.sha256 };
}

if (require.main === module) {
  const [archive, manifestPath, trustPath, website, index, output] = process.argv.slice(2);
  stagePages({ archive, manifestPath, trustPath, website, index, output })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { stagePages };
