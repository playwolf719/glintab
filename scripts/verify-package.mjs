import { readFile, access } from 'node:fs/promises';
import assert from 'node:assert/strict';
const directory = new URL('../output/chrome-mv3/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.ok(
  !manifest.host_permissions?.length,
  'Production must not silently grant blanket host permissions',
);
assert.ok(!manifest.content_scripts?.length, 'Extraction must be on demand, never on all websites');
assert.equal(manifest.options_ui.open_in_tab, true);
assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
for (const file of [
  'background.js',
  'auth-complete.html',
  'offscreen.html',
  'engine-worker.js',
  'options.html',
  'sidepanel.html',
  'content-scripts/drawer.js',
  'content-scripts/extract.js',
  ...Object.values(manifest.icons),
])
  await access(new URL(file, directory));
console.log('Manifest, on-demand permission model, entrypoints and icons verified.');
