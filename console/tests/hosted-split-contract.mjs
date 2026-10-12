import assert from 'node:assert/strict';
import { isIP } from 'node:net';

// This module is deliberately side-effect free. Contract tests never launch a
// browser, execute the mailbox helper, or contact an origin.
const PRODUCTION_HOSTS = new Set(['rsrs.rs', 'www.rsrs.rs', 'api.rsrs.rs', 'dash.rsrs.rs', 'dashboard.rsrs.rs', 'admin.rsrs.rs']);
const SHA = /^[0-9a-f]{40}$/;
export const APPROVALS = [
  'RSRS_SPLIT_SMOKE_APPROVED',
  'RSRS_SPLIT_ISOLATED_ENVIRONMENT_CONFIRMED',
  'RSRS_SPLIT_API_ADMIN_APPROVED',
  'RSRS_SPLIT_MAIL_APPROVED',
  'RSRS_SPLIT_FIXTURE_CLEANUP_APPROVED',
];

export function hostedOrigin(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an explicit isolated HTTPS origin`); }
  const hostname = url.hostname.toLowerCase();
  assert.ok(typeof value === 'string' && /^https:\/\/[^/?#\\\s]+\/?$/.test(value)
    && url.protocol === 'https:' && !url.username && !url.password
    && !url.search && !url.hash && url.pathname === '/' && !hostname.endsWith('.')
    && !isIP(hostname) && !hostname.startsWith('[')
    && hostname !== 'localhost' && !hostname.endsWith('.localhost')
    && !PRODUCTION_HOSTS.has(hostname) && !/(^|[.-])prod(?:uction)?([.-]|$)/.test(hostname),
  `${name} must be an isolated remote HTTPS origin without credentials, paths, queries, fragments, or production domains`);
  return url.origin;
}

export function readHostedConfig(env) {
  for (const name of APPROVALS) assert.equal(env[name], 'true', `${name}=true is required for this opt-in hosted test`);
  const origins = Object.fromEntries(['API', 'DASHBOARD', 'ADMIN', 'HOMEPAGE'].map(name => [name.toLowerCase(), hostedOrigin(env[`RSRS_SPLIT_${name}_ORIGIN`], `RSRS_SPLIT_${name}_ORIGIN`)]));
  assert.equal(new Set(Object.values(origins)).size, 4, 'Four distinct API, Dashboard, Admin, and homepage origins are required');
  for (const name of ['SERVER', 'SITE']) assert.ok(SHA.test(env[`RSRS_SPLIT_${name}_SHA`] || ''), `RSRS_SPLIT_${name}_SHA must be an exact 40-character lowercase source revision`);
  assert.ok(typeof env.RSRS_SPLIT_ADMIN_TOKEN === 'string' && env.RSRS_SPLIT_ADMIN_TOKEN.trim(), 'RSRS_SPLIT_ADMIN_TOKEN is required');
  assert.match(env.RSRS_SPLIT_MAIL_ADDRESS || '', /^[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+$/, 'A dedicated approved fixture recipient is required');
  let mailReader;
  try { mailReader = JSON.parse(env.RSRS_SPLIT_MAIL_READER); } catch { throw new Error('RSRS_SPLIT_MAIL_READER must be a JSON command array'); }
  assert.ok(Array.isArray(mailReader) && mailReader.length && mailReader.every(value => typeof value === 'string' && value.length > 0 && !value.includes('\0')), 'RSRS_SPLIT_MAIL_READER must be a nonempty JSON command array');
  const mailWaitSeconds = Number(env.RSRS_SPLIT_MAIL_WAIT_SECONDS ?? 120);
  assert.ok(Number.isFinite(mailWaitSeconds) && mailWaitSeconds >= 30 && mailWaitSeconds <= 600, 'RSRS_SPLIT_MAIL_WAIT_SECONDS must be between 30 and 600');
  // DEBUG/pw:api and Node HTTP diagnostics can log credentials and payloads.
  assert.ok(!env.DEBUG && !env.PWDEBUG && !env.NODE_DEBUG && !env.NODE_DEBUG_NATIVE, 'Disable debug logging before running the hosted smoke');
  return { origins, serverSha: env.RSRS_SPLIT_SERVER_SHA, siteSha: env.RSRS_SPLIT_SITE_SHA,
    adminToken: env.RSRS_SPLIT_ADMIN_TOKEN, mailAddress: env.RSRS_SPLIT_MAIL_ADDRESS, mailReader, mailWaitSeconds,
    output: env.RSRS_SPLIT_SMOKE_OUTPUT || 'browser-test-output/hosted-split',
    executablePath: env.RSRS_BROWSER_EXECUTABLE };
}

export function verifyCheckoutSource(revision, status, config) {
  assert.equal(revision.trim(), config.siteSha, 'Harness checkout must match the expected Site SHA');
  assert.equal(status.trim(), '', 'Harness checkout must be clean, including untracked files');
}

export function verifyApiSource(health, ready, config) {
  assert.equal(health?.ok, true, 'API health did not report success');
  assert.ok(SHA.test(health?.source_revision || ''), 'API source revision is missing or unknown');
  assert.equal(health.source_revision, config.serverSha, 'API source revision does not match the expected Server SHA');
  assert.equal(ready?.ok, true, 'API readiness did not report success');
  assert.equal(ready?.database, 'ready', 'API database is not ready');
}

export function verifySiteSource(metadata, target, config, importedRevision) {
  assert.equal(metadata?.site_revision, config.siteSha, `${target} source revision does not match the expected Site SHA`);
  assert.equal(metadata?.source_tree_dirty, false, `${target} source tree must be explicitly clean`);
  assert.equal(metadata?.target, target, `${target} artifact has the wrong build target`);
  if (target === 'homepage') {
    assert.equal(metadata?.base, '/', 'Homepage must be the root-origin Pages artifact');
  } else {
    assert.equal(metadata?.api_base_url, config.origins.api, `${target} artifact must use the isolated API origin`);
    assert.ok(SHA.test(importedRevision || ''), 'Local upstream import revision is missing');
    assert.equal(metadata?.imported_revision, importedRevision, `${target} imported console provenance does not match upstream.json`);
  }
}

export function requestViolation(config, request, resourceType) {
  let url;
  try { url = new URL(request.url); } catch { return 'invalid-request-url'; }
  if (!Object.values(config.origins).includes(url.origin) || url.username || url.password) return 'unapproved-origin';
  const authenticated = Object.keys(request.headers || {}).some(name => name.toLowerCase() === 'authorization');
  if ((['Fetch', 'XHR', 'Preflight'].includes(resourceType) || authenticated || !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) && url.origin !== config.origins.api) return 'api-request-to-frontend-origin';
  return null;
}

export async function getExact(request, url, contentType) {
  const response = await request.get(url, { maxRedirects: 0, timeout: 30000, headers: { 'Cache-Control': 'no-cache' } });
  assert.equal(response.status(), 200, 'Exact-origin artifact request failed or redirected');
  assert.equal(response.url(), url, 'Artifact response must remain at the requested URL');
  if (contentType) assert.match(response.headers()['content-type'] || '', contentType, 'Artifact content type is incorrect');
  return response;
}

export async function verifyHostedProvenance(request, config, importedRevision) {
  const health = await (await getExact(request, `${config.origins.api}/health`, /application\/json/i)).json();
  const ready = await (await getExact(request, `${config.origins.api}/ready`, /application\/json/i)).json();
  verifyApiSource(health, ready, config);
  for (const target of ['dashboard', 'admin', 'homepage']) {
    const metadata = await (await getExact(request, `${config.origins[target]}/build-info.json`, /application\/json/i)).json();
    verifySiteSource(metadata, target, config, importedRevision);
    await getExact(request, `${config.origins[target]}/`, /text\/html/i);
  }
  const home = await getExact(request, `${config.origins.homepage}/`, /text\/html/i);
  const html = await home.text();
  const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css|svg|png|webp)(?:\?[^"']*)?)["']/g)].map(match => new URL(match[1], home.url()));
  assert.ok(assets.length > 0, 'Homepage has no linked build assets');
  for (const asset of assets) {
    assert.ok(asset.origin === config.origins.homepage && !asset.username && !asset.password, 'Homepage asset is outside the isolated homepage origin');
    const mime = { js: /^(?:application|text)\/(?:javascript|ecmascript)(?:;|$)/i, css: /^text\/css(?:;|$)/i, svg: /^image\/svg\+xml(?:;|$)/i, png: /^image\/png(?:;|$)/i, webp: /^image\/webp(?:;|$)/i };
    await getExact(request, asset.href, mime[asset.pathname.split('.').at(-1)]);
  }
}
