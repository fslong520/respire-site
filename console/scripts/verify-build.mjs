import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// The console ships as one embedded single-file bundle: inline module script and
// styles, fonts kept as separate hashed files, plus the Pages routing files.
const dist = new URL('../dist/', import.meta.url);
const html = readFileSync(new URL('index.html', dist), 'utf8');
assert.match(html, /<script type="module"[^>]*>/, 'dist/index.html must inline its module script');
assert.ok(!/<script[^>]*\ssrc=/.test(html), 'The bundle must not reference external scripts');
assert.ok(!/<link[^>]*rel="stylesheet"/.test(html), 'Styles must be inlined by the single-file build');
assert.match(html, /\/[A-Za-z0-9_-]+\.woff2/, 'Fonts must stay separate files referenced with origin-absolute URLs');
const fonts = readdirSync(dist).filter(name => name.endsWith('.woff2'));
assert.ok(fonts.length > 0, 'No woff2 slices were emitted');
const metadata = JSON.parse(readFileSync(new URL('build-info.json', dist), 'utf8'));
assert.equal(metadata.target, 'console');
assert.match(metadata.site_revision, /^[0-9a-f]{40}$/);
assert.ok(metadata.api_base_url && metadata.dashboard_url && metadata.admin_url, 'Public API and hostname provenance is required');

const redirects = readFileSync(new URL('_redirects', dist), 'utf8');
assert.equal(redirects, readFileSync(new URL('../public/_redirects', import.meta.url), 'utf8'));
assert.ok(!redirects.startsWith('/* '), 'Do not shadow bundle assets with a catch-all rewrite');
const headers = readFileSync(new URL('_headers', dist), 'utf8');
assert.equal(headers, readFileSync(new URL('../public/_headers', import.meta.url), 'utf8'));
assert.match(headers, /Cache-Control: no-store/);
console.log(`Single console bundle verified: inline script and styles, ${fonts.length} font slices, Pages routing files intact.`);
