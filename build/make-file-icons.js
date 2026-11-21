// Generates the Cude icon theme: original, crisp 16px SVG file/folder/language icons (no icon font).
// Run: node build/make-file-icons.js  → extensions/cude-ai/media/icons/*.svg + themes/cude-icons.json
'use strict';
const fs = require('node:fs'), path = require('node:path');
const ext = path.join(__dirname, '..', 'extensions', 'cude-ai');
const dir = path.join(ext, 'media', 'icons');
fs.mkdirSync(dir, { recursive: true });
// Only remove files this generator owns (f-*, d-*, file/folder*). Other icons here (update.svg...) belong to the UI.
for (const name of fs.readdirSync(dir)) if (/^(f-|d-|file\.svg$|folder(-open)?\.svg$)/.test(name)) fs.rmSync(path.join(dir, name));

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="geometricPrecision">${body}</svg>`;
const FONT = `font-family="Segoe UI Variable Display,Segoe UI,Inter,Arial,sans-serif"`;

// Language badge: solid rounded square with a short, heavy label.
const badge = (bg, label, fg = '#fff') => {
  const size = label.length >= 4 ? 4.6 : label.length === 3 ? 5.6 : label.length === 2 ? 7 : 8.6;
  return svg(`<rect x="1.5" y="1.5" width="13" height="13" rx="3.2" fill="${bg}"/><rect x="1.5" y="1.5" width="13" height="13" rx="3.2" fill="url(#g)" opacity=".18"/><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><text x="8" y="${label.length >= 3 ? 10.3 : 10.9}" text-anchor="middle" ${FONT} font-weight="800" font-size="${size}" letter-spacing="-.25" fill="${fg}">${esc(label)}</text>`);
};
// Document outline with a coloured glyph drawn on top.
const doc = (color, glyph) => svg(`<path d="M3.6 1.5h5.7l3.2 3.2v9a.8.8 0 0 1-.8.8H3.6a.8.8 0 0 1-.8-.8V2.3a.8.8 0 0 1 .8-.8z" fill="${color}" fill-opacity=".13" stroke="${color}" stroke-opacity=".75" stroke-width=".9"/><path d="M9.3 1.5v3.2h3.2" fill="none" stroke="${color}" stroke-opacity=".75" stroke-width=".9" stroke-linejoin="round"/>${glyph}`);
const stroke = (color, d, w = 1.4) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

const ICONS = {
  // languages (badges)
  js: badge('#f1c40f', 'JS', '#2b2b2b'), jsx: badge('#20a8d8', 'JSX'), ts: badge('#3178c6', 'TS'), tsx: badge('#2f74c0', 'TSX'),
  py: badge('#3572a5', 'PY', '#ffd845'), rs: badge('#c0632f', 'RS'), go: badge('#00a7d0', 'GO'), java: badge('#d9622b', 'JV'),
  kt: badge('#7f52ff', 'KT'), c: badge('#5c6bc0', 'C'), cpp: badge('#4a5fb4', 'C++'), cs: badge('#7b4bc2', 'C#'), php: badge('#777bb4', 'PHP'),
  rb: badge('#c7322f', 'RB'), swift: badge('#f05138', 'SW'), dart: badge('#0f9bd7', 'DT'), lua: badge('#2c3e9e', 'LUA'), css: badge('#663399', 'CSS'),
  scss: badge('#c6538c', 'SCSS'), less: badge('#2a4d80', 'LESS'), vue: badge('#41b883', 'VUE'), svelte: badge('#ff3e00', 'SV'), r: badge('#276dc3', 'R'),
  sql: badge('#c98a1b', 'SQL'), yaml: badge('#cb3f3f', 'YML'), toml: badge('#9c6b4a', 'TML'), xml: badge('#e37933', 'XML'), gradle: badge('#02303a', 'GRD', '#9fe7ff'),
  zig: badge('#f7a41d', 'ZIG', '#2b2b2b'), ex: badge('#6e4a7e', 'EX'), hs: badge('#5e5086', 'HS'), scala: badge('#dc322f', 'SC'), ipynb: badge('#e46e2e', 'NB'),
  // documents & data (glyphs)
  json: svg(stroke('#e0a526', 'M5.6 2.8c-1.3 0-1.9.7-1.9 1.9v1.6c0 .8-.4 1.3-1.3 1.4v.6c.9.1 1.3.6 1.3 1.4v1.6c0 1.2.6 1.9 1.9 1.9') + stroke('#e0a526', 'M10.4 2.8c1.3 0 1.9.7 1.9 1.9v1.6c0 .8.4 1.3 1.3 1.4v.6c-.9.1-1.3.6-1.3 1.4v1.6c0 1.2-.6 1.9-1.9 1.9') + '<circle cx="8" cy="8" r="1" fill="#e0a526"/>'),
  md: svg(`<rect x="1" y="3.5" width="14" height="9" rx="2" fill="none" stroke="#5b8fd9" stroke-width="1.2"/>` + stroke('#5b8fd9', 'M3.6 10.3V5.8l1.8 2.1 1.8-2.1v4.5', 1.3) + stroke('#5b8fd9', 'M11 5.7v4.6M9.4 8.8l1.6 1.6 1.6-1.6', 1.3)),
  html: svg(stroke('#e5532d', 'M5.2 4.3 1.9 8l3.3 3.7M10.8 4.3 14.1 8l-3.3 3.7', 1.6) + stroke('#f08a5d', 'M9.1 3.3 6.9 12.7', 1.3)),
  txt: doc('#8b95a5', stroke('#8b95a5', 'M5 7.2h6M5 9.4h6M5 11.6h3.8', 1)),
  log: doc('#8b95a5', stroke('#8b95a5', 'M5 7.2h1M7.2 7.2H11M5 9.4h1M7.2 9.4H11M5 11.6h1M7.2 11.6h2.6', 1)),
  pdf: doc('#e2483d', `<rect x="3.6" y="8.2" width="8.8" height="4.6" rx="1.2" fill="#e2483d"/><text x="8" y="11.85" text-anchor="middle" ${FONT} font-weight="800" font-size="3.6" fill="#fff">PDF</text>`),
  img: svg(`<rect x="1.5" y="2.5" width="13" height="11" rx="2.2" fill="#9b6dd7" fill-opacity=".16" stroke="#9b6dd7" stroke-width="1.1"/><circle cx="5.4" cy="6" r="1.3" fill="#f4b740"/><path d="M2.6 12.3l3.6-3.9 2.4 2.4 1.8-1.7 3 3.2z" fill="#9b6dd7"/>`),
  svg: svg(`<rect x="1.5" y="1.5" width="13" height="13" rx="3.2" fill="#ffb13b" fill-opacity=".18" stroke="#f0a020" stroke-width="1"/>` + stroke('#e8900c', 'M4 11.5c1.5-5 6.5-5 8 0', 1.3) + '<rect x="2.9" y="10.6" width="2.2" height="2.2" rx=".4" fill="#e8900c"/><rect x="10.9" y="10.6" width="2.2" height="2.2" rx=".4" fill="#e8900c"/><circle cx="8" cy="4.6" r="1.3" fill="#e8900c"/>'),
  zip: doc('#a0784f', `<path d="M7.2 1.8h1.4v1.2H7.2zM8.6 3h1.2v1.2H8.6zM7.2 4.2h1.4v1.2H7.2zM8.6 5.4h1.2v1.2H8.6z" fill="#a0784f"/><rect x="6.6" y="7.4" width="3.2" height="3.6" rx=".8" fill="none" stroke="#a0784f" stroke-width="1"/>`),
  lock: svg(`<rect x="3" y="7" width="10" height="7.5" rx="1.8" fill="#8c96a3"/>` + stroke('#8c96a3', 'M5.3 7V5.1a2.7 2.7 0 0 1 5.4 0V7', 1.5) + '<circle cx="8" cy="10.5" r="1.1" fill="#fff"/>'),
  env: svg(`<circle cx="5.3" cy="10.7" r="3" fill="none" stroke="#e3b52a" stroke-width="1.6"/>` + stroke('#e3b52a', 'M7.5 8.5 13.3 2.7M11.2 4.8l1.5 1.5M12.6 3.4l1.2 1.2', 1.6)),
  csv: svg(`<rect x="1.5" y="2" width="13" height="12" rx="2" fill="#21a366" fill-opacity=".15" stroke="#21a366" stroke-width="1.1"/>` + stroke('#21a366', 'M1.8 6h12.4M1.8 10h12.4M6 2.3v11.4M10 2.3v11.4', 1)),
  db: svg(`<ellipse cx="8" cy="3.8" rx="5.2" ry="2" fill="#c98a1b"/><path d="M2.8 3.8v8.4c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2V3.8" fill="#c98a1b" fill-opacity=".25" stroke="#c98a1b" stroke-width="1"/>` + stroke('#c98a1b', 'M2.8 8c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2', 1)),
  font: svg(`<rect x="1.5" y="1.5" width="13" height="13" rx="3.2" fill="#c45d7a" fill-opacity=".16" stroke="#c45d7a" stroke-width="1"/><text x="8" y="11.4" text-anchor="middle" font-family="Georgia,serif" font-weight="700" font-size="8" fill="#c45d7a">Aa</text>`),
  video: svg(`<rect x="1.5" y="3" width="13" height="10" rx="2.2" fill="#d6528a"/><path d="M6.6 5.7v4.6L10.6 8z" fill="#fff"/>`),
  audio: svg(stroke('#2fb39a', 'M6 12V3.6l7-1.4v8.2', 1.4) + '<circle cx="4.4" cy="12" r="1.9" fill="#2fb39a"/><circle cx="11.4" cy="10.4" r="1.9" fill="#2fb39a"/>'),
  exe: svg(`<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#6b7a90" fill-opacity=".15" stroke="#6b7a90" stroke-width="1.1"/><path d="M1.8 5.4h12.4" stroke="#6b7a90" stroke-width="1.1"/><circle cx="3.6" cy="4" r=".55" fill="#6b7a90"/><circle cx="5.3" cy="4" r=".55" fill="#6b7a90"/>`),
  term: svg(`<rect x="1.5" y="2.5" width="13" height="11" rx="2.2" fill="#2d333b"/>` + stroke('#5fd38d', 'M4.2 6.2 6.6 8l-2.4 1.8', 1.3) + stroke('#cdd5df', 'M8 10.4h3.6', 1.3)),
  ps1: svg(`<rect x="1.5" y="2.5" width="13" height="11" rx="2.2" fill="#2a5c9a"/>` + stroke('#fff', 'M4.2 6.2 6.6 8l-2.4 1.8', 1.3) + stroke('#fff', 'M8 10.4h3.6', 1.3)),
  config: svg(stroke('#8b95a5', 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11', 1.2) + '<circle cx="5.5" cy="4.5" r="1.6" fill="#8b95a5"/><circle cx="10.5" cy="8" r="1.6" fill="#8b95a5"/><circle cx="7" cy="11.5" r="1.6" fill="#8b95a5"/>'),
  git: svg(`<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2" transform="rotate(45 8 8)" fill="#f05033"/>` + stroke('#fff', 'M6.3 4.9v6.2M6.3 6.4l3.4 3.4', 1.1) + '<circle cx="6.3" cy="11.1" r="1" fill="#fff"/><circle cx="9.9" cy="9.9" r="1" fill="#fff"/><circle cx="6.3" cy="4.9" r="1" fill="#fff"/>'),
  npm: svg(`<rect x="1.5" y="1.5" width="13" height="13" rx="2.6" fill="#cb3837"/><path d="M4.2 11.8V4.2h7.6v7.6H9.9V6.1H8v5.7z" fill="#fff"/>`),
  docker: svg(`<path d="M1.6 8.6h11.2c.9 0 1.6-.5 1.9-1.3.3.1.6.4.7.7-.5.4-1 .5-1.5.4-.9 2.9-3.4 4.6-6.7 4.6-3 0-5.1-1.6-5.6-4.4z" fill="#1d91e6"/><path d="M3.4 6.3h1.8v1.8H3.4zM5.6 6.3h1.8v1.8H5.6zM7.8 6.3h1.8v1.8H7.8zM5.6 4.1h1.8v1.8H5.6zM7.8 4.1h1.8v1.8H7.8zM10 6.3h1.8v1.8H10z" fill="#1d91e6"/>`),
  readme: svg(`<circle cx="8" cy="8" r="6.5" fill="#3d8bfd"/><circle cx="8" cy="4.9" r="1.05" fill="#fff"/><path d="M7.1 7h1.8v4.7H7.1z" fill="#fff"/>`),
  license: svg(`<path d="M3.6 1.5h8.8c.4 0 .8.4.8.8v8.4H2.8V2.3c0-.4.4-.8.8-.8z" fill="#d4a949" fill-opacity=".18" stroke="#c9972b" stroke-width="1"/>` + stroke('#c9972b', 'M5 4.6h6M5 6.8h4', 1) + '<circle cx="10.6" cy="10.8" r="2.4" fill="#c9972b"/><path d="M9.4 12.6l-.6 2.4 1.8-.9 1.8.9-.6-2.4" fill="#c9972b"/>'),
  ai: svg(`<path d="M8 1.2c.5 3.4 2.1 5 5.6 5.6-3.5.6-5.1 2.2-5.6 5.6C7.5 9 5.9 7.4 2.4 6.8 5.9 6.2 7.5 4.6 8 1.2z" fill="#d6865a"/><path d="M12.6 10.4c.2 1.4.9 2.1 2.2 2.3-1.3.2-2 .9-2.2 2.3-.2-1.4-.9-2.1-2.3-2.3 1.4-.2 2.1-.9 2.3-2.3z" fill="#e8b08a"/>`),
  cude: svg(`<rect x="1.5" y="1.5" width="13" height="13" rx="3.4" fill="#c8743f"/>` + stroke('#fff', 'M10.6 5.2A3.4 3.4 0 1 0 10.6 10.8', 1.8) + '<circle cx="11" cy="8" r="1" fill="#fff"/>'),
  android: svg(`<path d="M3.2 11.6V7.4a4.8 4.8 0 0 1 9.6 0v4.2z" fill="#3ddc84"/><circle cx="6" cy="8.8" r=".8" fill="#fff"/><circle cx="10" cy="8.8" r=".8" fill="#fff"/>` + stroke('#3ddc84', 'M5 3.6 4.1 2.3M11 3.6l.9-1.3', 1.1)),
};
// Fallback document
const FILE = doc('#8b95a5', stroke('#8b95a5', 'M5 8h6M5 10.4h4.4', 1));

// ---------- Folders: back panel + front panel, optional white glyph ----------
const shade = (hex, k) => { const n = parseInt(hex.slice(1), 16); const f = c => Math.max(0, Math.min(255, Math.round(c * k))); return '#' + [f(n >> 16), f((n >> 8) & 255), f(n & 255)].map(v => v.toString(16).padStart(2, '0')).join(''); };
const GLYPHS = {
  code: stroke('#fff', 'M7.3 7.6 5.8 9.4l1.5 1.8M10.2 7.6l1.5 1.8-1.5 1.8', 1.1),
  test: stroke('#fff', 'M6.2 9.6l1.5 1.4 2.9-2.9', 1.25),
  docs: stroke('#fff', 'M6 8h5M6 9.7h5M6 11.4h3.2', 1),
  image: '<path d="M5.6 11.6l1.9-2.1 1.3 1.2 1-1 1.6 1.9z" fill="#fff"/><circle cx="7" cy="7.9" r=".8" fill="#fff"/>',
  git: stroke('#fff', 'M7 7.4v4.2M7 8.5l2.6 1.6', 1) + '<circle cx="7" cy="11.6" r=".75" fill="#fff"/><circle cx="9.8" cy="10.2" r=".75" fill="#fff"/>',
  pkg: '<path d="M8.6 6.9l2.6 1.4v2.9l-2.6 1.4L6 11.2V8.3z" fill="none" stroke="#fff" stroke-width=".95" stroke-linejoin="round"/><path d="M6 8.3l2.6 1.4 2.6-1.4M8.6 9.7v2.9" fill="none" stroke="#fff" stroke-width=".95" stroke-linejoin="round"/>',
  term: stroke('#fff', 'M6 7.9l1.6 1.3L6 10.5M8.6 11h2.4', 1.05),
  gear: '<circle cx="8.6" cy="9.5" r="1.3" fill="none" stroke="#fff" stroke-width="1"/>' + stroke('#fff', 'M8.6 6.9v.9M8.6 11.2v.9M6 9.5h.9M10.3 9.5h.9M6.8 7.7l.6.6M9.8 10.7l.6.6M10.4 7.7l-.6.6M7.4 10.7l-.6.6', .9),
  box: '<rect x="6" y="7.6" width="5.2" height="4" rx=".7" fill="none" stroke="#fff" stroke-width="1"/>' + stroke('#fff', 'M6 9h5.2', .9),
  cude: stroke('#fff', 'M10.2 8a2 2 0 1 0 0 3', 1.2),
  globe: '<circle cx="8.6" cy="9.5" r="2.3" fill="none" stroke="#fff" stroke-width=".95"/>' + stroke('#fff', 'M6.3 9.5h4.6M8.6 7.2c-1.2 1.4-1.2 3.2 0 4.6M8.6 7.2c1.2 1.4 1.2 3.2 0 4.6', .8),
  star: '<path d="M8.6 7l.7 1.5 1.6.2-1.2 1.1.3 1.6-1.4-.8-1.4.8.3-1.6-1.2-1.1 1.6-.2z" fill="#fff"/>',
  android: '<path d="M6.3 11.3V9.9a2.3 2.3 0 0 1 4.6 0v1.4z" fill="#fff"/>',
  shield: '<path d="M8.6 6.9l2.3.9v1.6c0 1.4-1 2.4-2.3 2.9-1.3-.5-2.3-1.5-2.3-2.9V7.8z" fill="#fff"/>',
};
const folderSvg = (color, open, glyph) => {
  const back = shade(color, .8), g = glyph ? GLYPHS[glyph] : '';
  return open
    ? svg(`<path d="M1.5 3.4c0-.6.4-1 1-1h3.3c.3 0 .6.1.8.3l1.1 1.1h5.3c.6 0 1 .4 1 1v1.4H4.2c-.6 0-1.1.4-1.3.9L1.5 11.5z" fill="${back}"/><path d="M3.3 6.9c.2-.5.6-.8 1.1-.8h10.2c.7 0 1.1.7.9 1.3l-1.6 4.9c-.2.5-.6.8-1.1.8H2.4c-.7 0-1.1-.7-.9-1.3z" fill="${color}"/>${g ? `<g transform="translate(-.3 .4)">${g}</g>` : ''}`)
    : svg(`<path d="M1.5 3.4c0-.6.4-1 1-1h3.3c.3 0 .6.1.8.3l1.1 1.1h5.8c.6 0 1 .4 1 1v.7h-13z" fill="${back}"/><rect x="1.5" y="5" width="13" height="8.6" rx="1.1" fill="${color}"/><path d="M1.5 6.1h13" stroke="#fff" stroke-opacity=".18" stroke-width=".7"/>${g}`);
};
const FOLDERS = {
  // name: [color, glyph]
  src: ['#4f8ef7', 'code'], source: ['#4f8ef7', 'code'], lib: ['#4f8ef7', 'code'], app: ['#4f8ef7', 'code'], core: ['#4f8ef7', 'code'], pkg: ['#4f8ef7', 'code'],
  test: ['#2ea44f', 'test'], tests: ['#2ea44f', 'test'], __tests__: ['#2ea44f', 'test'], spec: ['#2ea44f', 'test'], e2e: ['#2ea44f', 'test'],
  docs: ['#5b8fd9', 'docs'], doc: ['#5b8fd9', 'docs'], documentation: ['#5b8fd9', 'docs'],
  node_modules: ['#7cb342', 'pkg'], vendor: ['#7cb342', 'pkg'], packages: ['#7cb342', 'pkg'],
  '.git': ['#f05033', 'git'], '.github': ['#6e7781', 'git'], '.gitlab': ['#e2432a', 'git'],
  '.vscode': ['#3c8fdc', 'gear'], '.idea': ['#7b61ff', 'gear'], config: ['#7c8796', 'gear'], configs: ['#7c8796', 'gear'], settings: ['#7c8796', 'gear'],
  '.cude': ['#c8743f', 'cude'], '.claude': ['#c8743f', 'cude'], '.codex': ['#5f6b7a', 'cude'],
  build: ['#a37850', 'box'], dist: ['#a37850', 'box'], out: ['#a37850', 'box'], release: ['#a37850', 'box'], bin: ['#a37850', 'box'], target: ['#a37850', 'box'],
  public: ['#26a7c9', 'globe'], static: ['#26a7c9', 'globe'], www: ['#26a7c9', 'globe'], web: ['#26a7c9', 'globe'],
  assets: ['#9b6dd7', 'image'], images: ['#9b6dd7', 'image'], img: ['#9b6dd7', 'image'], media: ['#9b6dd7', 'image'], icons: ['#9b6dd7', 'image'], resources: ['#9b6dd7', 'image'], res: ['#9b6dd7', 'image'],
  scripts: ['#3fa36b', 'term'], tools: ['#3fa36b', 'term'], bin_scripts: ['#3fa36b', 'term'],
  components: ['#20a8d8', 'star'], views: ['#20a8d8', 'star'], pages: ['#20a8d8', 'star'], ui: ['#20a8d8', 'star'],
  android: ['#3ddc84', 'android'], security: ['#d4453b', 'shield'], auth: ['#d4453b', 'shield'],
  data: ['#d39b2b', ''], models: ['#c8743f', ''], styles: ['#c6538c', ''], themes: ['#c6538c', ''], i18n: ['#26a7c9', 'globe'], locales: ['#26a7c9', 'globe'],
};

// ---------- Theme ----------
const theme = { iconDefinitions: {}, file: '_file', folder: '_folder', folderExpanded: '_folderOpen', rootFolder: '_folder', rootFolderExpanded: '_folderOpen',
  fileExtensions: {}, fileNames: {}, folderNames: {}, folderNamesExpanded: {}, languageIds: {}, hidesExplorerArrows: false };
const def = (id, file, body) => { fs.writeFileSync(path.join(dir, file), body); theme.iconDefinitions[id] = { iconPath: '../media/icons/' + file }; };
def('_file', 'file.svg', FILE);
def('_folder', 'folder.svg', folderSvg('#9aa7ba', false));
def('_folderOpen', 'folder-open.svg', folderSvg('#9aa7ba', true));
for (const [id, body] of Object.entries(ICONS)) def('f_' + id, 'f-' + id + '.svg', body);

const EXT = {
  js: ['js', 'mjs', 'cjs'], jsx: ['jsx'], ts: ['ts', 'mts', 'cts'], tsx: ['tsx'], py: ['py', 'pyw', 'pyi'], ipynb: ['ipynb'], rs: ['rs'], go: ['go'],
  java: ['java', 'jar', 'class'], kt: ['kt', 'kts'], c: ['c', 'h'], cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'], cs: ['cs', 'csx'], php: ['php'],
  rb: ['rb', 'erb'], swift: ['swift'], dart: ['dart'], lua: ['lua'], css: ['css'], scss: ['scss', 'sass'], less: ['less'], vue: ['vue'], svelte: ['svelte'],
  r: ['r', 'rmd'], sql: ['sql'], yaml: ['yml', 'yaml'], toml: ['toml'], xml: ['xml', 'plist', 'xaml', 'csproj', 'xsd'], gradle: ['gradle'], zig: ['zig'],
  ex: ['ex', 'exs'], hs: ['hs'], scala: ['scala', 'sc'], json: ['json', 'jsonc', 'json5', 'jsonl'], md: ['md', 'mdx', 'markdown'], html: ['html', 'htm', 'xhtml'],
  txt: ['txt', 'rtf'], log: ['log', 'out'], pdf: ['pdf'], img: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'tif', 'tiff', 'heic'], svg: ['svg'],
  zip: ['zip', 'tar', 'gz', '7z', 'rar', 'tgz', 'bz2', 'xz'], lock: ['lock'], env: ['env', 'pem', 'key', 'crt'], csv: ['csv', 'tsv', 'xlsx', 'xls', 'ods'],
  db: ['db', 'sqlite', 'sqlite3', 'duckdb', 'parquet'], font: ['ttf', 'otf', 'woff', 'woff2'], video: ['mp4', 'mov', 'webm', 'mkv', 'avi'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a'], exe: ['exe', 'dll', 'msi', 'so', 'dylib', 'app'], term: ['sh', 'bash', 'zsh', 'fish', 'bat', 'cmd'],
  ps1: ['ps1', 'psm1', 'psd1'], config: ['ini', 'cfg', 'conf', 'properties', 'editorconfig'], ai: ['gguf', 'safetensors', 'onnx', 'pt', 'pth', 'ckpt', 'bin', 'h5'],
  android: ['apk', 'aab'],
};
for (const [id, list] of Object.entries(EXT)) for (const e of list) theme.fileExtensions[e] = 'f_' + id;
Object.assign(theme.fileNames, {
  'package.json': 'f_npm', 'package-lock.json': 'f_lock', 'npm-shrinkwrap.json': 'f_lock', '.npmrc': 'f_npm', 'yarn.lock': 'f_lock', 'pnpm-lock.yaml': 'f_lock', 'bun.lockb': 'f_lock', 'cargo.lock': 'f_lock',
  dockerfile: 'f_docker', 'docker-compose.yml': 'f_docker', 'docker-compose.yaml': 'f_docker', 'compose.yml': 'f_docker', '.dockerignore': 'f_docker',
  '.gitignore': 'f_git', '.gitattributes': 'f_git', '.gitmodules': 'f_git', '.gitkeep': 'f_git',
  license: 'f_license', 'license.md': 'f_license', 'license.txt': 'f_license', copying: 'f_license', notice: 'f_license',
  'readme.md': 'f_readme', readme: 'f_readme', 'readme.txt': 'f_readme', 'changelog.md': 'f_md',
  '.env': 'f_env', '.env.local': 'f_env', '.env.example': 'f_env', '.env.production': 'f_env', '.env.development': 'f_env',
  'tsconfig.json': 'f_ts', 'jsconfig.json': 'f_js', '.eslintrc': 'f_config', '.prettierrc': 'f_config', 'makefile': 'f_term', 'gradlew': 'f_gradle', 'gradlew.bat': 'f_gradle',
  'androidmanifest.xml': 'f_android', 'claude.md': 'f_cude', 'agents.md': 'f_cude', 'cude.md': 'f_cude', '.cuderules': 'f_cude', 'requirements.txt': 'f_py', 'pyproject.toml': 'f_py',
});
for (const [name, [color, glyph]] of Object.entries(FOLDERS)) {
  const id = 'd_' + name.replace(/[^a-z0-9]/gi, '_');
  def(id, 'd-' + id + '.svg', folderSvg(color, false, glyph)); def(id + '_o', 'd-' + id + '-o.svg', folderSvg(color, true, glyph));
  theme.folderNames[name] = id; theme.folderNamesExpanded[name] = id + '_o';
}
Object.assign(theme.languageIds, {
  javascript: 'f_js', javascriptreact: 'f_jsx', typescript: 'f_ts', typescriptreact: 'f_tsx', json: 'f_json', jsonc: 'f_json', markdown: 'f_md', python: 'f_py',
  html: 'f_html', css: 'f_css', scss: 'f_scss', less: 'f_less', shellscript: 'f_term', bat: 'f_term', powershell: 'f_ps1', yaml: 'f_yaml', xml: 'f_xml', sql: 'f_sql',
  plaintext: 'f_txt', log: 'f_log', dockerfile: 'f_docker', ignore: 'f_git', rust: 'f_rs', go: 'f_go', java: 'f_java', kotlin: 'f_kt', c: 'f_c', cpp: 'f_cpp',
  csharp: 'f_cs', php: 'f_php', ruby: 'f_rb', swift: 'f_swift', dart: 'f_dart', lua: 'f_lua', vue: 'f_vue', svelte: 'f_svelte', ini: 'f_config', toml: 'f_toml',
  properties: 'f_config', makefile: 'f_term', r: 'f_r', 'jupyter': 'f_ipynb', groovy: 'f_gradle', svg: 'f_svg', diff: 'f_git', 'git-commit': 'f_git',
});
fs.writeFileSync(path.join(ext, 'themes', 'cude-icons.json'), JSON.stringify(theme, null, 1));
console.log('icons', Object.keys(theme.iconDefinitions).length, 'ext', Object.keys(theme.fileExtensions).length, 'names', Object.keys(theme.fileNames).length, 'folders', Object.keys(theme.folderNames).length, 'langs', Object.keys(theme.languageIds).length);
