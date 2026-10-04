import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const root = new URL('../', import.meta.url);
const source = JSON.parse(readFileSync(new URL('upstream.json', root), 'utf8'));
for (const [path, expected] of Object.entries(source.unchanged_sha256)) {
  const actual = createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex');
  assert.equal(actual, expected, `Unrecorded change to imported source ${path}`);
}
for (const path of ['src/api.js', 'src/config.js', 'src/consoleRoute.js', 'src/crypto.js', 'src/hashRoute.js', 'src/i18n.js', 'src/treeModel.js']) {
  execFileSync(process.execPath, ['--check', new URL(path, root).pathname]);
}
console.log(`Verified ${Object.keys(source.unchanged_sha256).length} unchanged imported files from ${source.commit}. JSX is checked by both Vite builds.`);
