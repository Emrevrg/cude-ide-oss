import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const DAY = 86_400_000;
const MAX_PACKAGE = 2_000_000_000;

export type ReleaseTrust = { feed: string; key: string; fingerprint: string; poolKey?: string };
export type ReleaseManifest = {
  minimumVersion?: string; mandatory?: boolean; notes?: string;
  schema: number; platform: string; version: string; minPoolVersion: string; sequence: number;
  url: string; size: number; sha256: string; issuedAt: number; expiresAt: number;
};
export type ReleaseCheckpoint = { sequence: number; manifestHash: string };

export function compareVersions(left: string, right: string) {
  if (!VERSION.test(left) || !VERSION.test(right)) throw Error('Invalid release version.');
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
}

function httpsUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) throw Error('Invalid release URL.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('The release feed must use a plain HTTPS URL.');
  return url;
}

export function parseReleaseTrust(value: unknown): ReleaseTrust {
  const entry = value as Partial<ReleaseTrust> | null;
  const feed = httpsUrl(entry?.feed);
  if (typeof entry?.key !== 'string' || entry.key.length > 4096 || !entry.key.startsWith('-----BEGIN PUBLIC KEY-----')) throw Error('Provide a release public key in PEM format.');
  const key = createPublicKey(entry.key);
  if (key.asymmetricKeyType !== 'ed25519') throw Error('The release key must be Ed25519.');
  const fingerprint = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  let poolKey: string | undefined;
  if (typeof (entry as any)?.poolKey === 'string') {
    const candidate = (entry as any).poolKey as string;
    if (candidate.length <= 4096 && candidate.startsWith('-----BEGIN PUBLIC KEY-----') && createPublicKey(candidate).asymmetricKeyType === 'ed25519') poolKey = candidate;
  }
  return { feed: feed.toString(), key: entry.key, fingerprint, poolKey };
}

export function verifyManifest(envelope: unknown, trust: ReleaseTrust, checkpoint?: ReleaseCheckpoint, now = Date.now(), installedVersion?: string) {
  const input = envelope as { manifest?: ReleaseManifest; signature?: string } | null;
  if (!input?.manifest || typeof input.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(input.signature)) throw Error('Invalid signed release manifest.');
  const manifest = input.manifest;
  const payload = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (!verify(null, payload, createPublicKey(trust.key), Buffer.from(input.signature, 'base64'))) throw Error('The release signature is invalid.');
  const manifestHash = createHash('sha256').update(payload).digest('hex');
  if (manifest.schema !== 1 || manifest.platform !== 'win32-x64' || !VERSION.test(manifest.version || '') ||
      !VERSION.test(manifest.minPoolVersion || '') || compareVersions(manifest.version, manifest.minPoolVersion) < 0 ||
      !Number.isSafeInteger(manifest.sequence) || manifest.sequence < 1 || !Number.isSafeInteger(manifest.size) ||
      manifest.size < 1 || manifest.size > MAX_PACKAGE || !/^[0-9a-f]{64}$/.test(manifest.sha256 || '')) throw Error('Invalid release metadata.');
  if (checkpoint && (manifest.sequence < checkpoint.sequence ||
      (manifest.sequence === checkpoint.sequence && manifestHash !== checkpoint.manifestHash))) throw Error('Older or conflicting release manifest.');
  if (!Number.isSafeInteger(manifest.issuedAt) || !Number.isSafeInteger(manifest.expiresAt) ||
      manifest.issuedAt > now + 300_000 || manifest.expiresAt <= now || manifest.expiresAt <= manifest.issuedAt ||
      manifest.expiresAt - manifest.issuedAt > 30 * DAY) throw Error('The release manifest is outside its validity period.');
  if ((manifest.minimumVersion !== undefined && (!VERSION.test(manifest.minimumVersion) || compareVersions(manifest.version, manifest.minimumVersion) < 0)) ||
      (manifest.mandatory !== undefined && typeof manifest.mandatory !== 'boolean') ||
      (manifest.notes !== undefined && (typeof manifest.notes !== 'string' || manifest.notes.length > 4000))) throw Error('Invalid update policy.');
  // A signed manifest that offers nothing newer than the installed build never triggers a download,
  // so its archive location is irrelevant; every downloadable (newer) release must still be same-origin.
  if (installedVersion && VERSION.test(installedVersion) && compareVersions(manifest.version, installedVersion) <= 0) return { manifest, checkpoint: { sequence: manifest.sequence, manifestHash } };
  const archive = httpsUrl(manifest.url);
  if (archive.origin !== httpsUrl(trust.feed).origin ||
      path.posix.basename(archive.pathname) !== 'Cude-IDE-' + manifest.version + '-win32-x64.zip') throw Error('The archive URL does not match the trusted release feed.');
  return { manifest, checkpoint: { sequence: manifest.sequence, manifestHash } };
}

export async function fetchSignedRelease(trust: ReleaseTrust, checkpoint: ReleaseCheckpoint | undefined, signal: AbortSignal, request = fetch, installedVersion?: string) {
  const response = await request(trust.feed, { redirect: 'error', signal, headers: { accept: 'application/json' } });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 16_384) {
    await response.body?.cancel();
    throw Error('Could not read the release manifest.');
  }
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.length;
      if (size > 16_384) throw Error('The release manifest is too large.');
      chunks.push(value.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return verifyManifest(JSON.parse(Buffer.concat(chunks, size).toString('utf8')), trust, checkpoint, Date.now(), installedVersion);
}

export async function downloadSignedRelease(manifest: ReleaseManifest, target: string, signal: AbortSignal, request = fetch, progress?: (received: number, total: number) => void) {
  const response = await request(manifest.url, { redirect: 'error', signal, headers: { accept: 'application/zip', 'accept-encoding': 'identity' } });
  const length = response.headers.get('content-length');
  if (!response.ok || !response.body || (length !== null && Number(length) !== manifest.size)) {
    await response.body?.cancel();
    throw Error('The release archive could not be downloaded.');
  }
  const temp = target + '.' + randomUUID() + '.part';
  const reader = response.body.getReader();
  let handle: fs.FileHandle | undefined;
  let created = false;
  try {
    handle = await fs.open(temp, 'wx'); created = true;
    const hash = createHash('sha256');
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > manifest.size) throw Error('The release archive exceeds the signed size.');
      hash.update(value);
      await handle.writeFile(value);
      progress?.(size, manifest.size);
    }
    if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw Error('The archive digest does not match.');
    await handle.sync();
    await handle.close();
    handle = undefined;
    signal.throwIfAborted();
    await fs.link(temp, target);

  } finally {
    await reader.cancel().catch(() => {});
    await handle?.close().catch(() => {});
    if (created) await fs.unlink(temp).catch(() => {});
  }
}

