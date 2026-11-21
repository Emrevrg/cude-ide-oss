import { createPublicKey, verify } from 'node:crypto';

// Signed pool directory: lets every installed IDE find the current Cude Pool servers
// without an IDE update. Signed with the same Ed25519 release key as update manifests.
export type PoolDirectory = { schema: 1; urls: string[]; issuedAt: number; expiresAt: number };

const DAY = 86_400_000;

export function directoryUrl(feed: string) {
  const url = new URL(feed);
  url.pathname = url.pathname.replace(/\/update\/manifest\.json$/, '/pool.json');
  if (!url.pathname.endsWith('/pool.json')) url.pathname = url.pathname.replace(/\/[^/]*$/, '/pool.json');
  return url.toString();
}

export function verifyPoolDirectory(envelope: unknown, publicKeyPem: string | string[], now = Date.now()): PoolDirectory {
  const input = envelope as { pool?: PoolDirectory; signature?: string } | null;
  if (!input?.pool || typeof input.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(input.signature)) throw Error('Invalid signed pool directory.');
  const payload = Buffer.from(JSON.stringify(input.pool), 'utf8');
  const keys = (Array.isArray(publicKeyPem) ? publicKeyPem : [publicKeyPem]).filter(Boolean);
  if (!keys.some(key => verify(null, payload, createPublicKey(key), Buffer.from(input.signature!, 'base64')))) throw Error('The pool directory signature is invalid.');
  const pool = input.pool;
  if (pool.schema !== 1 || !Array.isArray(pool.urls) || !pool.urls.length || pool.urls.length > 8) throw Error('Invalid pool directory.');
  if (!Number.isSafeInteger(pool.issuedAt) || !Number.isSafeInteger(pool.expiresAt) || pool.issuedAt > now + 300_000 || pool.expiresAt <= now || pool.expiresAt - pool.issuedAt > 120 * DAY) throw Error('The pool directory is outside its validity period.');
  const urls = pool.urls.map(value => {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('Pool directory URLs must be plain HTTPS addresses.');
    return url.origin;
  });
  return { ...pool, urls: [...new Set(urls)] };
}

export async function fetchPoolDirectory(feed: string, publicKeyPem: string | string[], signal: AbortSignal, request: typeof fetch = fetch) {
  const response = await request(directoryUrl(feed), { redirect: 'error', signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw Error('Could not read the pool directory.');
  const text = await response.text();
  if (text.length > 16_384) throw Error('The pool directory is too large.');
  return verifyPoolDirectory(JSON.parse(text), publicKeyPem);
}

/** First server that answers /health within the timeout, in directory order. */
export async function pickHealthyPool(urls: string[], request: typeof fetch = fetch, timeoutMs = 4000) {
  for (const url of urls) {
    try {
      const response = await request(url + '/health', { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      await response.body?.cancel().catch(() => {});
      if (response.ok) return url;
    } catch {}
  }
  return undefined;
}
