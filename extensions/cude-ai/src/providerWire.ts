// Wire format for Cude's own provider connections (OpenAI-compatible, Anthropic, Gemini, Azure).
// Kept free of the vscode API so the exact request/stream logic can be exercised against real HTTP servers in tests.

import { boundedMcpBody as readBoundedBody } from './mcpSecurity';

export type WireMessage = { role: string; content: any };
export type WireFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;
export type WireText = (key: 'empty' | 'blocked' | 'streamError' | 'streamInterrupted' | 'http' | 'rateLimited' | 'authentication', values?: Record<string, string | number>) => string;
export type WireOptions = {
  provider: string; base: string; model: string; messages: WireMessage[]; key?: string;
  headers?: Record<string, string>; organization?: string; project?: string;
  stream: boolean; maxTokens?: number; temperature?: number; signal?: AbortSignal;
  onDelta?: (delta: string) => void; fetch: WireFetch; text: WireText; redact?: (value: string) => string;
  retryDelayMs?: number; extraBody?: Record<string, any>;
};

export class WireHttpError extends Error { constructor(message: string, public status: number, public body: string) { super(message); this.name = 'WireHttpError'; } }

const dataUrl = (url: string) => ({ mime: url.match(/^data:([^;]+);/)?.[1] || 'image/png', data: url.split(',')[1] || '' });
const textOf = (value: any): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part?.text || '').join('\n') : String(value ?? '');

/** Anthropic and Gemini reject consecutive turns from the same role and conversations that start with the assistant. */
export function alternateTurns(messages: WireMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) {
      const toParts = (value: any) => typeof value === 'string' ? [{ type: 'text', text: value }] : (value || []);
      last.content = typeof last.content === 'string' && typeof message.content === 'string' ? `${last.content}\n\n${message.content}` : [...toParts(last.content), ...toParts(message.content)];
    } else out.push({ role, content: message.content });
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: '(conversation continues)' });
  if (!out.length) out.push({ role: 'user', content: 'Hello.' });
  return out;
}

export function buildRequest(o: WireOptions, variant: { omitTemperature?: boolean; completionTokens?: boolean } = {}) {
  const base = o.base.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(o.headers || {}) };
  const system = o.messages.filter(m => m.role === 'system').map(m => textOf(m.content)).join('\n\n');
  let url: string, body: any;
  if (o.provider === 'anthropic') {
    url = `${base}/messages`; headers['anthropic-version'] = '2023-06-01'; if (o.key) headers['x-api-key'] = o.key;
    const content = (value: any) => typeof value === 'string' ? value : value.map((part: any) => part.type === 'image_url' ? (({ mime, data }) => ({ type: 'image', source: { type: 'base64', media_type: mime, data } }))(dataUrl(part.image_url.url)) : { type: 'text', text: part.text || '' });
    body = { model: o.model, max_tokens: o.maxTokens || 8192, messages: alternateTurns(o.messages).map(m => ({ role: m.role, content: content(m.content) })), ...(system ? { system } : {}), ...(o.stream ? { stream: true } : {}) };
    if (o.temperature !== undefined && !variant.omitTemperature) body.temperature = o.temperature;
  } else if (o.provider === 'gemini') {
    const model = encodeURIComponent(o.model.replace(/^models\//, ''));
    url = o.stream ? `${base}/models/${model}:streamGenerateContent?alt=sse` : `${base}/models/${model}:generateContent`;
    if (o.key) headers['x-goog-api-key'] = o.key;
    const parts = (value: any) => typeof value === 'string' ? [{ text: value }] : value.map((part: any) => part.type === 'image_url' ? (({ mime, data }) => ({ inlineData: { mimeType: mime, data } }))(dataUrl(part.image_url.url)) : { text: part.text || '' });
    body = { contents: alternateTurns(o.messages).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: parts(m.content) })), ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) };
    const generationConfig: any = {}; if (o.maxTokens) generationConfig.maxOutputTokens = o.maxTokens; if (o.temperature !== undefined && !variant.omitTemperature) generationConfig.temperature = o.temperature;
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  } else {
    url = `${base}/chat/completions`;
    if (o.provider === 'azure') { if (o.key) headers['api-key'] = o.key; } else if (o.key) headers.authorization = `Bearer ${o.key}`;
    if (o.organization) headers['OpenAI-Organization'] = o.organization; if (o.project) headers['OpenAI-Project'] = o.project;
    body = { model: o.model, messages: o.messages, stream: o.stream, ...(o.extraBody || {}) };
    if (o.temperature !== undefined && !variant.omitTemperature) body.temperature = o.temperature;
    if (o.maxTokens) body[variant.completionTokens ? 'max_completion_tokens' : 'max_tokens'] = o.maxTokens;
  }
  return { url, headers, body };
}

/** Reads a server-sent-events body and yields each `data:` payload (multi-line events are joined). */
async function* sseEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader(), decoder = new TextDecoder(); let buffer = '', data: string[] = [];
  const flush = function* () { if (data.length) { const payload = data.join('\n'); data = []; yield payload; } };
  let bytes=0,eventSize=0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes+=value.byteLength;
      if(bytes>8_000_000)throw new Error('Provider stream exceeded its size limit.');
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
      if(buffer.length>1_000_000)throw new Error('Provider event exceeded its size limit.');
      for (const line of lines) {
        if(line===''){eventSize=0;yield* flush();}
        else if(line.startsWith('data:')){
          eventSize+=line.length;
          if(eventSize>1_000_000)throw new Error('Provider event exceeded its size limit.');
          data.push(line.slice(5).replace(/^ /,''));
        }
      }
    }
    buffer += decoder.decode(); if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, '')); yield* flush();
  } finally { void reader.cancel().catch(()=>{}); reader.releaseLock(); }
}

const errorText=(value:any):string=>typeof value==='string'?value:String(value?.message??value?.error?.message??JSON.stringify(value)??'');

function parseProviderJson(serialized:string):unknown{
  try{return JSON.parse(serialized);}
  catch{throw new Error('Provider returned invalid JSON.');}
}

async function readStream(o: WireOptions, response: Response, emit: (delta: string) => void) {
  let result = '', finish = '', ended=false;
  for await (const raw of sseEvents(response.body as ReadableStream<Uint8Array>)) {
    if(raw==='[DONE]'){ended=true;break;}
    if(!raw)continue; let event: any; try { event = JSON.parse(raw); } catch { continue; }
    if (event?.error || event?.type === 'error') throw new Error(o.text('streamError', { detail: (o.redact ? o.redact(errorText(event.error || event)) : errorText(event.error || event)).slice(0,500) }));
    if(o.provider==='anthropic'&&event.type==='message_stop'){ended=true;break;}
    let part = '';
    if (o.provider === 'anthropic') { if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') part = event.delta.text || ''; if (event.type === 'message_delta' && event.delta?.stop_reason) finish = event.delta.stop_reason; }
    else if (o.provider === 'gemini') { const candidate = event.candidates?.[0]; part = (candidate?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || '').join(''); if (candidate?.finishReason) finish = candidate.finishReason; if (event.promptFeedback?.blockReason) finish = event.promptFeedback.blockReason; }
    else { const choice = event.choices?.[0]; part = typeof choice?.delta?.content === 'string' ? choice.delta.content : ''; if (choice?.finish_reason) finish = choice.finish_reason; }
    if (part) { result += part; emit(part); }
  }
  return { result, finish: typeof finish==='string'?finish:'', interrupted:!ended&&!finish };
}

function readJson(o: WireOptions, data: any) {
  if (o.provider === 'anthropic') return { result: (data.content || []).map((x: any) => x.type === 'text' || x.text ? x.text || '' : '').join(''), finish: data.stop_reason || '' };
  if (o.provider === 'gemini') { const candidate = data.candidates?.[0]; return { result: (candidate?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || '').join(''), finish: candidate?.finishReason || data.promptFeedback?.blockReason || '' }; }
  const message = data.choices?.[0]?.message; const content = typeof message?.content === 'string' ? message.content : Array.isArray(message?.content) ? message.content.map((p: any) => p.text || '').join('') : '';
  return { result: content, finish: data.choices?.[0]?.finish_reason || '' };
}

const RETRY_STATUS = new Set([500, 502, 503, 504, 529]);
const sleep=(ms:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
  const cancel=()=>{clearTimeout(timer);reject(Object.assign(new Error('aborted'),{name:'AbortError'}));};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},ms);
  if(signal?.aborted)cancel();
  else signal?.addEventListener('abort',cancel,{once:true});
});

/**
 * Sends one chat turn and returns the full answer, streaming deltas when requested.
 * Recovers on its own from: transient 5xx/network failures (before any text was shown), models that reject
 * `temperature`, and models that require `max_completion_tokens`. Empty or blocked answers become clear errors.
 */
export async function callProvider(o: WireOptions): Promise<string> {
  const variant: { omitTemperature?: boolean; completionTokens?: boolean } = {};
  let emitted = false; const emit = (delta: string) => { emitted = true; o.onDelta?.(delta); };
  for (let attempt = 0; ; attempt++) {
    const { url, headers, body } = buildRequest(o, variant);
    let response: Response;
    try { response = await o.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: o.signal }); }
    catch (error: any) { if (error?.name === 'AbortError' || o.signal?.aborted || attempt >= 2) throw error; await sleep((o.retryDelayMs ?? 800) * (attempt + 1), o.signal); continue; }
    if (!response.ok) {
      const detail = await readBoundedBody(response,64_000).catch(() => '');
      if (response.status === 400 && attempt < 3) {
        if (!variant.omitTemperature && body.temperature !== undefined && /temperature/i.test(detail)) { variant.omitTemperature = true; continue; }
        if (!variant.completionTokens && /max_completion_tokens/i.test(detail)) { variant.completionTokens = true; continue; }
      }
      if (RETRY_STATUS.has(response.status) && attempt < 2) { await sleep((o.retryDelayMs ?? 800) * (attempt + 1), o.signal); continue; }
      const safe=(o.redact?o.redact(detail):detail).slice(0,500);
      if(response.status===401||response.status===403)throw new WireHttpError(o.text('authentication'),response.status,'');
      if(response.status===429)throw new WireHttpError(o.text('rateLimited'),429,safe);
      throw new WireHttpError(o.text('http', { status: response.status, detail: safe }), response.status, safe);
    }
    const isStream = o.stream && response.body && /event-stream/i.test(response.headers.get('content-type') || 'text/event-stream');
    let outcome: { result: string; finish: string; interrupted?:boolean };
    try { outcome = isStream ? await readStream(o, response, emit) : readJson(o,parseProviderJson(await readBoundedBody(response,8_000_000))); }
    catch (error: any) {
      const transient = /fetch failed|terminated|ECONNRESET|socket|other side closed|premature close/i.test(String(error?.message || error));
      if (error?.name === 'AbortError' || o.signal?.aborted || !transient) throw error;
      if(emitted||attempt>=2){if(isStream)throw new Error(o.text('streamInterrupted'));throw error;}
      await sleep((o.retryDelayMs ?? 800) * (attempt + 1), o.signal); continue;
    }
    if(outcome.interrupted){
      if(!emitted&&attempt<2){await sleep((o.retryDelayMs??800)*(attempt+1),o.signal);continue;}
      throw new Error(o.text('streamInterrupted'));
    }
    if(typeof outcome.finish!=='string')outcome.finish='';
    if (!isStream && o.onDelta && outcome.result) for (let i = 0; i < outcome.result.length; i += 24) emit(outcome.result.slice(i, i + 24));
    if (!outcome.result.trim()) {
      if (/safety|blocklist|prohibited|recitation|content_filter|refusal|spii/i.test(outcome.finish)) throw new Error(o.text('blocked', { reason: (o.redact?o.redact(outcome.finish):outcome.finish).slice(0,120) }));
      throw new Error(o.text('empty', { reason: (o.redact?o.redact(outcome.finish):outcome.finish).slice(0,120) || 'none' }));
    }
    return outcome.result;
  }
}
