import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser';
import { parseDocument, isMap, isSeq, visit } from 'yaml';

const writeQueues = new Map<string, Promise<void>>();

export type Target = { id: string; label: string; file: string; key?: string; detect?: string[]; schema?: 'opencode' | 'continue' };
export type BridgeEntry = { command: string; args: string[]; env: Record<string, string> };
const object = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function jsonConfig(text: string) {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !object(value)) throw new Error('Invalid MCP configuration object');
  return value;
}

function yamlConfig(text: string) {
  const doc = parseDocument(text);
  // Refuse aliases rather than expanding or changing shared configuration nodes.
  let alias = false;
  visit(doc, { Alias() { alias = true; } });
  if (doc.errors.length || !isMap(doc.contents) || alias) throw new Error('Invalid MCP YAML configuration');
  return doc;
}

export function bridgeConfigured(target: Target, text: string): boolean {
  if (target.schema === 'continue') {
    const servers = yamlConfig(text).get('mcpServers');
    return isSeq(servers) && servers.items.some(item => isMap(item) && item.get('name') === 'cude-ide' && !!item.get('command'));
  }
  const entry = jsonConfig(text)[target.key ?? 'mcpServers']?.['cude-ide'];
  return object(entry) && entry.enabled !== false && entry.disabled !== true && !!entry.command;
}

/** Build the complete update before touching the file or its backup. */
export function bridgeConfigText(target: Target, text: string | undefined, entry: BridgeEntry): string {
  if (target.schema === 'continue') {
    const doc = yamlConfig(text ?? 'name: Cude Config\nversion: 1.0.0\nschema: v1\n');
    let servers = doc.get('mcpServers');
    if (servers === undefined) { doc.set('mcpServers', doc.createNode([])); servers = doc.get('mcpServers'); }
    if (!isSeq(servers)) throw new Error('MCP servers must be a YAML sequence');
    const value = { name: 'cude-ide', ...entry };
    let replaced = false;
    for (let i = servers.items.length - 1; i >= 0; i--) {
      const item = servers.items[i];
      if (isMap(item) && item.get('name') === 'cude-ide') {
        if (replaced) servers.delete(i);
        else { servers.set(i, doc.createNode(value)); replaced = true; }
      }
    }
    if (!replaced) servers.add(doc.createNode(value));
    return doc.toString();
  }
  const source = text ?? '{}';
  const config = jsonConfig(source), key = target.key ?? 'mcpServers';
  if (config[key] !== undefined && !object(config[key])) throw new Error('MCP servers must be an object');
  const value = target.schema === 'opencode'
    ? { type: 'local', command: [entry.command, ...entry.args], environment: entry.env, enabled: true, timeout: 30000 }
    : key === 'servers' ? { type: 'stdio', ...entry } : entry;
  return applyEdits(source, modify(source, [key, 'cude-ide'], value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' } }));
}

export async function writeBridgeConfig(target: Target, entry: BridgeEntry): Promise<void> {
  const lockKey = path.resolve(target.file).toLowerCase();
  const prev = writeQueues.get(lockKey) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async () => {
    let original: string | undefined;
    try { original = await fs.readFile(target.file, 'utf8'); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const updated = bridgeConfigText(target, original, entry);
    if (original === updated) return;
    await fs.mkdir(path.dirname(target.file), { recursive: true });
    // Preserve the exact original bytes, including comments and line endings.
    if (original !== undefined) await fs.copyFile(target.file, target.file + '.cude-backup');
    const tmp = `${target.file}.cude-tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      await fs.writeFile(tmp, updated, { mode: 0o600 });
      await fs.rename(tmp, target.file);
    } catch (error) {
      try { await fs.unlink(tmp); } catch {}
      throw error;
    }
  });
  writeQueues.set(lockKey, run);
  try { await run; }
  finally { if (writeQueues.get(lockKey) === run) writeQueues.delete(lockKey); }
}
