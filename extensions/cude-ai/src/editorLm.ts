import * as vscode from 'vscode';

/** Editor models use the same text JSON tool protocol as every other Gateway backend. */
export class EditorLanguageModels {
  private models: vscode.LanguageModelChat[] = [];
  private refreshRun?: Promise<void>;
  private disposed = false;
  private started = false;
  private change?: vscode.Disposable;
  constructor(private changed: () => void) {
    if (typeof vscode.lm?.onDidChangeChatModels === 'function') {
      this.change = vscode.lm.onDidChangeChatModels(() => { if (this.started) void this.refresh().catch(() => {}); });
    }
  }
  async refresh() {
    if (this.disposed) return;
    this.started = true;
    if (this.refreshRun) return this.refreshRun;
    this.refreshRun = (async () => {
      const models = typeof vscode.lm?.selectChatModels === 'function' ? await vscode.lm.selectChatModels() : [];
      if (this.disposed) return;
      this.models = models;
      this.changed();
    })();
    try { await this.refreshRun; } finally { this.refreshRun = undefined; }
  }
  profiles() {
    const groups = new Map<string, string[]>();
    for (const model of this.models) {
      const ids = groups.get(model.vendor) || [];
      if (!ids.includes(model.id)) ids.push(model.id);
      groups.set(model.vendor, ids);
    }
    return [...groups].map(([vendor, models]) => ({
      id: `editor-lm:${encodeURIComponent(vendor)}`, name: `Editör modelleri · ${vendor}`,
      provider: 'editor-lm', baseUrl: '', models,
    }));
  }
  async chat(providerId: string, modelId: string, messages: Array<{role:string;content:any}>, signal?: AbortSignal, onDelta?: (text:string) => void) {
    signal?.throwIfAborted();
    await this.refresh();
    signal?.throwIfAborted();
    const model = this.models.find(item => `editor-lm:${encodeURIComponent(item.vendor)}` === providerId && item.id === modelId);
    if (!model) throw new Error(`Editor model unavailable: ${modelId}`);
    const prompt = messages.map(message => {
      let content: string;
      if (typeof message.content === 'string') content = message.content;
      else if (Array.isArray(message.content) && message.content.every(part => part?.type === 'text' && typeof part.text === 'string')) content = message.content.map(part => part.text).join('\n');
      else throw new Error('Editor models currently accept text only. Remove image attachments for this request.');
      // The stable LM API has User/Assistant roles, so preserve system instructions as user context.
      return message.role === 'assistant' ? vscode.LanguageModelChatMessage.Assistant(content)
        : vscode.LanguageModelChatMessage.User(message.role === 'system' ? `Instructions:\n${content}` : content);
    });
    const cancellation = new vscode.CancellationTokenSource();
    const abort = () => cancellation.cancel();
    signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) abort();
    try {
      signal?.throwIfAborted();
      const response = await model.sendRequest(prompt, {}, cancellation.token);
      let result = '';
      for await (const delta of response.text) {
        signal?.throwIfAborted();
        result += delta;
        onDelta?.(delta);
      }
      signal?.throwIfAborted();
      return result;
    } finally {
      signal?.removeEventListener('abort', abort);
      cancellation.dispose();
    }
  }
  dispose() { this.disposed = true; this.models = []; this.change?.dispose(); }
}
