import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { normalizeApiBase } from '../src/config.js';
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
for (const target of ['dashboard', 'admin']) {
  const base = new URL(`../dist/${target}/`, import.meta.url);
  const metadata = JSON.parse(readFileSync(new URL('build-info.json', base), 'utf8'));
  assert.equal(metadata.site_revision, revision);
  assert.equal(metadata.target, target);
  assert.equal(typeof metadata.source_tree_dirty, 'boolean');
  if (process.env.CI) assert.equal(metadata.source_tree_dirty, false, 'Release/CI artifacts must come from clean source');
  assert.equal(metadata.api_base_url, normalizeApiBase(process.env.VITE_API_BASE_URL));
  assert.match(readFileSync(new URL('index.html', base), 'utf8'), /<script type="module"[^>]*>/);
  assert.equal(readFileSync(new URL('_redirects', base), 'utf8'), readFileSync(new URL('../public/_redirects', import.meta.url), 'utf8'));
  assert.ok(!readFileSync(new URL('_redirects', base), 'utf8').startsWith('/* '), 'Do not shadow provenance/license files with a catch-all rewrite');
  assert.match(readFileSync(new URL('_headers', base), 'utf8'), /Cache-Control: no-store/);
}
console.log('Both Pages outputs have expected configuration, metadata and routing.');
