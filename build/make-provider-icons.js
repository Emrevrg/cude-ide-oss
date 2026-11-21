// Builds extensions/cude-ai/media/provider-icons.json from @lobehub/icons-static-svg (MIT).
// Usage: node build/make-provider-icons.js <path-to-unpacked-package>/icons
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error('Usage: node make-provider-icons.js <icons dir>'); process.exit(1); }
const map = {
  openai: 'openai', anthropic: 'anthropic', 'google-gemini': 'gemini-color', 'google-vertex': 'vertexai-color',
  'azure-openai': 'azure-color', 'aws-bedrock': 'bedrock-color', mistral: 'mistral-color', cohere: 'cohere-color',
  xai: 'xai', deepseek: 'deepseek-color', moonshot: 'moonshot', 'moonshot-anthropic': 'moonshot', zai: 'zai',
  qwen: 'qwen-color', minimax: 'minimax-color', 'minimax-anthropic': 'minimax-color', baichuan: 'baichuan-color',
  stepfun: 'stepfun-color', '01ai': 'yi-color', groq: 'groq', cerebras: 'cerebras-color', sambanova: 'sambanova-color',
  together: 'together-color', fireworks: 'fireworks-color', deepinfra: 'deepinfra-color', openrouter: 'openrouter',
  cometapi: 'cometapi-color', featherless: 'featherless-color', parasail: 'parasail', 'inference-net': 'inference',
  'opencode-zen': 'opencode', 'llama-api': 'meta-color', nvidia: 'nvidia-color', huggingface: 'huggingface-color',
  replicate: 'replicate', perplexity: 'perplexity-color', ai21: 'ai21', nebius: 'nebius', hyperbolic: 'hyperbolic-color',
  novita: 'novita-color', lambda: 'lambda', cloudflare: 'cloudflare-color', 'github-models': 'github',
  'vercel-gateway': 'vercel', ollama: 'ollama', 'lm-studio': 'lmstudio', vllm: 'vllm-color', xinference: 'xinference-color',
  'codex-cli': 'codex-color', 'claude-code': 'claudecode-color', 'opencode-cli': 'opencode', 'gemini-cli': 'geminicli-color',
  'qwen-code': 'qwen-color', alibaba: 'alibabacloud-color', anyscale: 'anyscale-color', aihubmix: 'aihubmix-color'
};
const allowed = new Set(['svg', 'path', 'g', 'defs', 'linearGradient', 'radialGradient', 'stop', 'circle', 'rect', 'ellipse', 'polygon', 'mask', 'clipPath', 'title']);
const out = {};
for (const [id, file] of Object.entries(map)) {
  const full = path.join(src, file + '.svg');
  if (!fs.existsSync(full)) { console.warn('missing', file); continue; }
  let svg = fs.readFileSync(full, 'utf8').replace(/<title>[\s\S]*?<\/title>/g, '');
  for (const tag of svg.matchAll(/<\/?([a-zA-Z]+)/g)) if (!allowed.has(tag[1])) throw new Error(`${file}: unexpected <${tag[1]}>`);
  if (/\son[a-z]+\s*=|javascript:|href=|xlink/i.test(svg)) throw new Error(`${file}: unsafe attribute`);
  svg = svg.replace(/ height="1em"/, ' height="100%"').replace(/ width="1em"/, ' width="100%"').replace(/ style="[^"]*"/, '');
  // Gradient ids must be unique per icon so two icons on one page never share a definition.
  svg = svg.replace(/id="([^"]+)"/g, (_, v) => `id="ci-${id}-${v}"`).replace(/url\(#([^)]+)\)/g, (_, v) => `url(#ci-${id}-${v})`);
  out[id] = svg;
}
const target = path.join(__dirname, '..', 'extensions', 'cude-ai', 'media', 'provider-icons.json');
fs.writeFileSync(target, JSON.stringify(out));
console.log(Object.keys(out).length, 'icons', fs.statSync(target).size, 'bytes ->', target);
