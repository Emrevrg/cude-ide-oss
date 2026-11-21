// Runs Cude's real provider wire code against real local HTTP servers that speak each provider's protocol.
const assert = require('node:assert/strict');
const http = require('node:http');
const { callProvider, buildRequest, alternateTurns } = require('../out/providerWire');

const text = (key, values = {}) => `${key}:${Object.values(values).join('|')}`;
const seen = [];
let mode = {};

function sse(res, events) { res.writeHead(200, { 'content-type': 'text/event-stream' }); let i = 0; const next = () => { if (i >= events.length) return res.end(); res.write(events[i++]); setTimeout(next, 5); }; next(); }

const server = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const json = body ? JSON.parse(body) : {}; seen.push({ url: req.url, headers: req.headers, body: json });
    const m = mode[req.url.split('?')[0]] || {};
    if (m.failTimes > 0) { m.failTimes--; res.writeHead(m.failStatus || 503); return res.end('{"error":"busy"}'); }
    if (m.rejectTemperature && json.temperature !== undefined) { res.writeHead(400); return res.end('{"error":{"message":"Unsupported value: \'temperature\' does not support 0.2 with this model."}}'); }
    if (m.rejectMaxTokens && json.max_tokens !== undefined) { res.writeHead(400); return res.end('{"error":{"message":"Unsupported parameter: \'max_tokens\'. Use \'max_completion_tokens\' instead."}}'); }
    if (m.status) { res.writeHead(m.status); return res.end(m.body || '{"error":"nope"}'); }
    if (req.url.startsWith('/oa/chat/completions')) {
      if (m.midError) return sse(res, ['data: {"choices":[{"delta":{"content":"par"}}]}\n\n', 'data: {"error":{"message":"overloaded"}}\n\n']);
      if (m.empty) return sse(res, ['data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n', 'data: [DONE]\n\n']);
      if (!json.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })); }
      return sse(res, ['data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"Mer"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"haba"}}]}\r\n\r\n', 'data: {"choices":[{"delta":{"content":" Cude"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']);
    }
    if (req.url.startsWith('/an/messages')) {
      if (!json.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' })); }
      return sse(res, ['event: message_start\ndata: {"type":"message_start","message":{}}\n\n', 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Selam"}}\n\n', 'event: ping\ndata: {"type":"ping"}\n\n', 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" dünya"}}\n\n', 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'event: message_stop\ndata: {"type":"message_stop"}\n\n']);
    }
    if (req.url.startsWith('/ge/models/')) {
      if (m.blocked) return sse(res, ['data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n']);
      if (req.url.includes(':generateContent')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] })); }
      return sse(res, ['data: {"candidates":[{"content":{"parts":[{"text":"thinking","thought":true}]}}]}\r\n\r\n', 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Gemini "}]}}]}\r\n\r\n', 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hazır"}]},"finishReason":"STOP"}]}\r\n\r\n']);
    }
    res.writeHead(404); res.end('missing');
  });
});

const base = port => `http://127.0.0.1:${port}`;
const fetcher = (url, init) => fetch(url, init);
async function run(port) {
  const common = { model: 'm1', key: 'sk-test-123', stream: true, temperature: 0.2, fetch: fetcher, text, retryDelayMs: 5, redact: v => v.replaceAll('sk-test-123', '***') };
  const msgs = [{ role: 'system', content: 'You are Cude.' }, { role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'c' }, { role: 'user', content: 'd' }];

  // OpenAI-compatible streaming with real deltas, CRLF event separators and bearer auth.
  let deltas = [];
  assert.equal(await callProvider({ ...common, provider: 'openai-compatible', base: base(port) + '/oa/', messages: msgs, onDelta: d => deltas.push(d) }), 'Merhaba Cude');
  assert.deepEqual(deltas, ['Mer', 'haba', ' Cude']);
  assert.equal(seen.at(-1).headers.authorization, 'Bearer sk-test-123');
  assert.equal(seen.at(-1).body.stream, true);

  // Azure uses api-key, not bearer.
  await callProvider({ ...common, provider: 'azure', base: base(port) + '/oa', messages: msgs, onDelta: () => { } });
  assert.equal(seen.at(-1).headers['api-key'], 'sk-test-123'); assert.equal(seen.at(-1).headers.authorization, undefined);

  // Anthropic: real SSE, x-api-key, system separated, same-role turns merged, starts with user.
  deltas = [];
  assert.equal(await callProvider({ ...common, provider: 'anthropic', base: base(port) + '/an', messages: msgs, onDelta: d => deltas.push(d) }), 'Selam dünya');
  assert.deepEqual(deltas, ['Selam', ' dünya']);
  const an = seen.at(-1);
  assert.equal(an.headers['x-api-key'], 'sk-test-123'); assert.equal(an.headers['anthropic-version'], '2023-06-01');
  assert.equal(an.body.system, 'You are Cude.'); assert.equal(an.body.stream, true);
  assert.deepEqual(an.body.messages.map(x => x.role), ['user', 'assistant', 'user']);
  assert.equal(an.body.messages[0].content, 'a\n\nb');

  // Gemini: streamGenerateContent?alt=sse, thought parts hidden, key header.
  deltas = [];
  assert.equal(await callProvider({ ...common, provider: 'gemini', base: base(port) + '/ge', model: 'models/gemini-x', messages: msgs, onDelta: d => deltas.push(d) }), 'Gemini hazır');
  assert.deepEqual(deltas, ['Gemini ', 'hazır']);
  assert.match(seen.at(-1).url, /^\/ge\/models\/gemini-x:streamGenerateContent\?alt=sse$/);
  assert.equal(seen.at(-1).headers['x-goog-api-key'], 'sk-test-123');
  assert.equal(seen.at(-1).body.systemInstruction.parts[0].text, 'You are Cude.');

  // Non-streaming probes for every format.
  for (const [provider, path] of [['openai-compatible', '/oa'], ['anthropic', '/an'], ['gemini', '/ge']]) assert.equal(await callProvider({ ...common, provider, base: base(port) + path, messages: [{ role: 'user', content: 'Reply OK.' }], stream: false, maxTokens: 16 }), 'OK');

  // Transient 503 twice, then success: retried, no error shown.
  mode['/oa/chat/completions'] = { failTimes: 2, failStatus: 503 };
  assert.equal(await callProvider({ ...common, provider: 'openai', base: base(port) + '/oa', messages: msgs, onDelta: () => { } }), 'Merhaba Cude');
  // Reasoning model rejecting temperature: retried without it.
  mode['/oa/chat/completions'] = { rejectTemperature: true };
  assert.equal(await callProvider({ ...common, provider: 'openai', base: base(port) + '/oa', messages: msgs, onDelta: () => { } }), 'Merhaba Cude');
  assert.equal(seen.at(-1).body.temperature, undefined);
  // Model requiring max_completion_tokens.
  mode['/oa/chat/completions'] = { rejectMaxTokens: true };
  assert.equal(await callProvider({ ...common, provider: 'openai', base: base(port) + '/oa', messages: msgs, stream: false, maxTokens: 16 }), 'OK');
  assert.equal(seen.at(-1).body.max_completion_tokens, 16);
  // Error in the middle of a stream is surfaced, not swallowed as an empty answer.
  mode['/oa/chat/completions'] = { midError: true };
  await assert.rejects(callProvider({ ...common, provider: 'openai', base: base(port) + '/oa', messages: msgs, onDelta: () => { } }), /^Error: streamError:overloaded$/);
  // Content filter with no text -> clear blocked message.
  mode['/oa/chat/completions'] = { empty: true };
  await assert.rejects(callProvider({ ...common, provider: 'openai', base: base(port) + '/oa', messages: msgs, onDelta: () => { } }), /blocked:content_filter/);
  mode['/ge/models/gemini-x:streamGenerateContent'] = { blocked: true };
  await assert.rejects(callProvider({ ...common, provider: 'gemini', base: base(port) + '/ge', model: 'gemini-x', messages: msgs, onDelta: () => { } }), /blocked:SAFETY/);
  // Auth failures use the short message and do not include response details.
  mode['/oa/chat/completions'] = { status: 401, body: '{"error":"invalid key sk-test-123"}' };
  await assert.rejects(callProvider({ ...common, provider: 'openai', base: base(port) + '/oa', messages: msgs, onDelta: () => { } }), e => e.status===401 && /authentication/.test(e.message) && e.body==='');
  mode['/oa/chat/completions'] = { status: 429, body: JSON.stringify({error:'quota sk-test-123'}) };
  await assert.rejects(callProvider({ ...common, provider: 'openai', base: base(port) + '/oa', messages: msgs, onDelta: () => { } }), error => /rateLimited/.test(error.message) && !error.body.includes('sk-test-123'));
  mode = {};
  // Cancellation stops immediately.
  const controller = new AbortController(); controller.abort();
  await assert.rejects(callProvider({ ...common, provider: 'openai', base: base(port) + '/oa', messages: msgs, signal: controller.signal, onDelta: () => { } }), e => e.name === 'AbortError');
  // Network down (closed port) -> retried then real error.
  await assert.rejects(callProvider({ ...common, provider: 'openai', base: 'http://127.0.0.1:9', messages: msgs, onDelta: () => { } }));

  // Pure helpers.
  assert.deepEqual(alternateTurns([{ role: 'assistant', content: 'x' }]).map(x => x.role), ['user', 'assistant']);
  assert.equal(buildRequest({ provider: 'openai', base: 'https://a/v1/', model: 'm', messages: [], stream: false, fetch: fetcher, text }).url, 'https://a/v1/chat/completions');
  assert.equal(buildRequest({ provider: 'gemini', base: 'https://g/v1beta', model: 'models/x', messages: [], stream: false, fetch: fetcher, text }).url, 'https://g/v1beta/models/x:generateContent');
}

server.listen(0, '127.0.0.1', async () => {
  try { await run(server.address().port); console.log('provider wire runtime tests passed'); }
  catch (error) { console.error(error); process.exitCode = 1; }
  finally { server.close(); }
});
