import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const upstream = JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8'));

test('every byte-checked import is explicitly checked out with LF', () => {
  for (const path of Object.keys(upstream.unchanged_sha256)) {
    const attributes = execFileSync('git', ['check-attr', '-z', 'text', 'eol', '--', path], { cwd: root, encoding: 'utf8' }).split('\0');
    assert.deepEqual(attributes, [path, 'text', 'auto', path, 'eol', 'lf', '']);
    assert.ok(!readFileSync(join(root, path)).includes(Buffer.from('\r\n')), `${path} must retain upstream LF bytes`);
  }
});

test('source checks accept paths with spaces and still reject real imported-content changes', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'respire source check '));
  try {
    const files = new Set([
      ...Object.keys(upstream.unchanged_sha256),
      'upstream.json', 'package.json', 'scripts/check-source.mjs',
      'src/api.js', 'src/config.js', 'src/consoleRoute.js',
    ]);
    for (const path of files) {
      const target = join(temporary, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(root, path), target);
    }
    const check = () => execFileSync(process.execPath, [join(temporary, 'scripts/check-source.mjs')], { encoding: 'utf8', stdio: 'pipe' });
    assert.match(check(), /Verified 25 unchanged imported files/);
    const changed = join(temporary, 'src/crypto.js');
    writeFileSync(changed, Buffer.concat([readFileSync(changed), Buffer.from('\n// changed content\n')]));
    assert.throws(check, error => error.status !== 0 && /Unrecorded change to imported source src\/crypto\.js/.test(String(error.stderr)));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
