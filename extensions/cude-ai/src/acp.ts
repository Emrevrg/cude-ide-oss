import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

type Launch = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };

export async function runAcpPrompt(launch: Launch, prompt: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const process = spawn(launch.command, launch.args, {
    cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true
  });
  const input = createInterface({ input: process.stdout, crlfDelay: Infinity });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let sessionId: string | undefined;
  let output = '';
  const fail = (error: Error) => {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  const send = (value: object) => process.stdin.write(JSON.stringify(value) + '\n');
  const request = (method: string, params: object) => new Promise<any>((resolve, reject) => {
    if (signal.aborted || process.exitCode !== null) return reject(new Error('ACP connection closed.'));
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const cancel = () => {
    if (sessionId && !process.stdin.destroyed) send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    fail(new Error('ACP request cancelled or timed out.'));
  };
  process.once('error', () => fail(new Error('Could not start the ACP agent.')));
  process.once('exit', () => fail(new Error('The ACP agent exited before replying.')));
  process.stdin.on('error', () => fail(new Error('The ACP agent connection closed.')));
  input.on('line', line => {
    if (line.length > 1_000_000) { fail(new Error('ACP message exceeded its size limit.')); return; }
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.method && message.id !== undefined) {
      const result = message.method === 'session/request_permission' ? { result: { outcome: { outcome: 'cancelled' } } } :
        { error: { code: -32601, message: 'Client method unavailable' } };
      send({ jsonrpc: '2.0', id: message.id, ...result });
    } else if (message.method === 'session/update' && sessionId && message.params?.sessionId === sessionId) {
      const update = message.params.update;
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
        output += update.content.text.slice(0, Math.max(0, 250_000 - output.length));
      }
    } else if (typeof message.id === 'number') {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new Error('The ACP agent rejected the request.'));
      else item.resolve(message.result);
    }
  });
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'Cude IDE', version: '0.1.0' } });
    if (init?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version.');
    const session = await request('session/new', { cwd: launch.cwd, mcpServers: [] });
    if (typeof session?.sessionId !== 'string' || !session.sessionId) throw new Error('ACP agent returned an invalid session.');
    sessionId = session.sessionId as string;
    await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
    if (!output.trim()) throw new Error('ACP agent returned no text.');
    return output;
  } finally {
    signal.removeEventListener('abort', cancel);
    input.close();
    process.kill();
  }
}
