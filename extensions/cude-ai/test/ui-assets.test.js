const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('every icon/asset referenced by the manifest, webviews and icon theme exists', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const refs = new Set();
  const walk = v => { if (typeof v === 'string' && /^media\/.+\.(svg|png)$/.test(v)) refs.add(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(pkg.contributes);
  for (const f of ['chat.html', 'providers.html', 'welcome.html']) {
    const file = path.join(root, 'media', f);
    if (fs.existsSync(file)) for (const m of fs.readFileSync(file, 'utf8').matchAll(/media\/icons\/[\w.-]+\.svg/g)) refs.add(m[0]);
  }
  for (const r of refs) assert.ok(fs.existsSync(path.join(root, r)), `missing ${r}`);
  assert.ok(refs.has('media/icons/update.svg'), 'updates activity icon is referenced');
  const theme = JSON.parse(fs.readFileSync(path.join(root, 'themes', 'cude-icons.json'), 'utf8'));
  for (const [id, def] of Object.entries(theme.iconDefinitions)) assert.ok(fs.existsSync(path.join(root, 'themes', def.iconPath)), `icon ${id}`);
  for (const id of [...Object.values(theme.fileExtensions), ...Object.values(theme.fileNames), ...Object.values(theme.folderNames), ...Object.values(theme.languageIds)]) assert.ok(theme.iconDefinitions[id], `undefined icon id ${id}`);
});
