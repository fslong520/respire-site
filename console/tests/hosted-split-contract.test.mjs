import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { APPROVALS, hostedOrigin, readHostedConfig, verifyCheckoutSource, verifyApiSource, verifySiteSource, requestViolation, getExact, verifyHostedProvenance } from './hosted-split-contract.mjs';

const SERVER_SHA = '1'.repeat(40);
const SITE_SHA = '2'.repeat(40);
const IMPORT_SHA = '3'.repeat(40);
const env = () => ({
  ...Object.fromEntries(APPROVALS.map(name => [name, 'true'])),
  RSRS_SPLIT_API_ORIGIN: 'https://api.test.invalid',
  RSRS_SPLIT_DASHBOARD_ORIGIN: 'https://dashboard.test.invalid',
  RSRS_SPLIT_ADMIN_ORIGIN: 'https://admin.test.invalid',
  RSRS_SPLIT_HOMEPAGE_ORIGIN: 'https://homepage.test.invalid',
  RSRS_SPLIT_SERVER_SHA: SERVER_SHA,
  RSRS_SPLIT_SITE_SHA: SITE_SHA,
  RSRS_SPLIT_ADMIN_TOKEN: 'unit-only-placeholder',
  RSRS_SPLIT_MAIL_ADDRESS: 'synthetic@test.invalid',
  RSRS_SPLIT_MAIL_READER: '["python3","scripts/read-dev-mail.py"]',
});
const config = () => readHostedConfig(env());
const metadata = target => ({ site_revision: SITE_SHA, source_tree_dirty: false, target,
  ...(target === 'homepage' ? { base: '/' } : { api_base_url: config().origins.api, imported_revision: IMPORT_SHA }) });

// All "requests" below are in-memory objects. No fetch, sockets, browser, mail,
// subprocess, environment credentials, or approved hosted run is involved.
function mockHosted() {
  const cfg = config();
  const records = new Map();
  const seen = [];
  const put = (url, body, type = 'application/json', status = 200) => records.set(url, { body, type, status });
  put(`${cfg.origins.api}/health`, { ok: true, service: 'respire', source_revision: SERVER_SHA });
  put(`${cfg.origins.api}/ready`, { ok: true, database: 'ready' });
  for (const target of ['dashboard', 'admin', 'homepage']) {
    put(`${cfg.origins[target]}/build-info.json`, metadata(target));
    put(`${cfg.origins[target]}/`, target === 'homepage' ? '<script src="/assets/home.js"></script><link href="/assets/home.css" rel="stylesheet"><img src="/logo.svg">' : '<html>console</html>', 'text/html');
  }
  put(`${cfg.origins.homepage}/assets/home.js`, 'window.fixture = true;', 'text/javascript; charset=utf-8');
  put(`${cfg.origins.homepage}/assets/home.css`, 'body {}', 'text/css');
  put(`${cfg.origins.homepage}/logo.svg`, '<svg/>', 'image/svg+xml');
  const request = { async get(url, options) {
    assert.equal(options.maxRedirects, 0, 'Every probe must disable redirects');
    assert.equal(options.timeout, 30000);
    assert.deepEqual(options.headers, { 'Cache-Control': 'no-cache' });
    seen.push(url);
    assert.ok(records.has(url), 'Mock must not access an unconfigured destination');
    const row = records.get(url);
    return { status: () => row.status, url: () => row.finalUrl || url, headers: () => ({ 'content-type': row.type }), json: async () => row.body, text: async () => row.body };
  } };
  return { cfg, records, seen, request, put };
}

test('opt-in configuration has four explicit origins and independent source revisions', () => {
  const result = config();
  assert.equal(new Set(Object.values(result.origins)).size, 4);
  assert.equal(result.serverSha, SERVER_SHA);
  assert.equal(result.siteSha, SITE_SHA);
  assert.notEqual(result.serverSha, result.siteSha);
  assert.equal(result.mailWaitSeconds, 120);
  assert.equal(hostedOrigin('https://preview.test.invalid/', 'origin'), 'https://preview.test.invalid');
});

test('each approval is independently mandatory and accepts only literal true', () => {
  for (const approval of APPROVALS) for (const value of [undefined, '', 'false', 'yes', '1', 'TRUE', true]) {
    assert.throws(() => readHostedConfig({ ...env(), [approval]: value }), new RegExp(approval));
  }
});

test('all origins are mandatory and no legacy environment variable is a fallback', () => {
  for (const target of ['API', 'DASHBOARD', 'ADMIN', 'HOMEPAGE']) {
    assert.throws(() => readHostedConfig({ ...env(), [`RSRS_SPLIT_${target}_ORIGIN`]: undefined, RSRS_DEV_SERVER_ADDR: 'https://dev.rsrs.rs' }));
  }
  assert.throws(() => readHostedConfig({ ...env(), RSRS_SPLIT_ADMIN_ORIGIN: env().RSRS_SPLIT_DASHBOARD_ORIGIN }), /Four distinct/);
});

test('origins reject known production, credentials, non-HTTPS, loopback, IPs, paths, queries, fragments, and normalization escapes', () => {
  for (const origin of ['https://rsrs.rs', 'https://www.rsrs.rs', 'https://api.rsrs.rs', 'https://dash.rsrs.rs', 'https://dashboard.rsrs.rs', 'https://admin.rsrs.rs', 'https://api.rsrs.rs:8443', 'https://API.RSRS.RS', 'https://api.rsrs.rs.', 'https://api%2ersrs%2ers', 'https://production.example.invalid', 'https://app.prod.example.invalid',
    'http://isolated.test.invalid', '//isolated.test.invalid', 'https://localhost', 'https://test.localhost', 'https://127.0.0.1', 'https://127.1', 'https://2130706433', 'https://[::1]', 'https://[::ffff:127.0.0.1]',
    'https://user:pass@isolated.test.invalid', 'https://user@isolated.test.invalid', 'https://isolated.test.invalid/path', 'https://isolated.test.invalid/./', 'https://isolated.test.invalid/%2e/', 'https://isolated.test.invalid/?', 'https://isolated.test.invalid?token=x', 'https://isolated.test.invalid#', 'https://isolated.test.invalid/#x', 'https://isolated.test.invalid\\@example.invalid', ' https://isolated.test.invalid', 'https://isolated.test.invalid\n']) {
    assert.throws(() => hostedOrigin(origin, 'fixture origin'), `Rejected: ${origin}`);
  }
});

test('both exact revisions, dedicated recipient, token, mail command and bounded timeout are required', () => {
  for (const key of ['SERVER', 'SITE']) for (const value of [undefined, 'main', 'abcd123', 'A'.repeat(40), 'x'.repeat(40), '1'.repeat(39)]) {
    assert.throws(() => readHostedConfig({ ...env(), [`RSRS_SPLIT_${key}_SHA`]: value }));
  }
  for (const [key, values] of Object.entries({
    RSRS_SPLIT_ADMIN_TOKEN: [undefined, '', ' '],
    RSRS_SPLIT_MAIL_ADDRESS: [undefined, '', 'arbitrary name', 'x@test.invalid\n'],
    RSRS_SPLIT_MAIL_READER: [undefined, '{}', '[]', '[""]', '[1]', 'python3 script.py'],
    RSRS_SPLIT_MAIL_WAIT_SECONDS: ['0', '29', '601', 'NaN', 'Infinity'],
  })) for (const value of values) assert.throws(() => readHostedConfig({ ...env(), [key]: value }));
});

test('debug modes that may expose credentials are rejected', () => {
  for (const key of ['DEBUG', 'PWDEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE']) assert.throws(() => readHostedConfig({ ...env(), [key]: '1' }), /debug logging/);
});

test('the harness checkout must be the expected clean Site revision', () => {
  verifyCheckoutSource(`${SITE_SHA}\n`, '', config());
  assert.throws(() => verifyCheckoutSource(SERVER_SHA, '', config()), /checkout must match/);
  for (const status of [' M tests/smoke.mjs', '?? untracked-file']) assert.throws(() => verifyCheckoutSource(SITE_SHA, status, config()), /checkout must be clean/);
});

test('API revision is compiled health metadata, never legacy proxy headers', () => {
  verifyApiSource({ ok: true, source_revision: SERVER_SHA }, { ok: true, database: 'ready' }, config());
  for (const revision of [undefined, 'unknown', SITE_SHA, 'main', SERVER_SHA.slice(0, 7)]) assert.throws(() => verifyApiSource({ ok: true, source_revision: revision, 'x-respire-server-sha': SERVER_SHA }, { ok: true, database: 'ready' }, config()));
  for (const ready of [{ database: 'ready' }, { ok: false, database: 'ready' }, { ok: true, database: 'unavailable' }]) assert.throws(() => verifyApiSource({ ok: true, source_revision: SERVER_SHA }, ready, config()));
});

test('Dashboard, Admin, and homepage must all match the same exact clean Site SHA and build target', () => {
  for (const target of ['dashboard', 'admin', 'homepage']) {
    verifySiteSource(metadata(target), target, config(), IMPORT_SHA);
    for (const patch of [{ site_revision: SERVER_SHA }, { site_revision: undefined }, { source_tree_dirty: true }, { source_tree_dirty: 'false' }, { source_tree_dirty: undefined }, { target: 'wrong' }]) assert.throws(() => verifySiteSource({ ...metadata(target), ...patch }, target, config(), IMPORT_SHA));
  }
});

test('console provenance additionally pins API origin and checked-in import revision', () => {
  for (const target of ['dashboard', 'admin']) for (const patch of [{ api_base_url: 'https://api.rsrs.rs' }, { api_base_url: `${config().origins.api}/` }, { api_base_url: undefined }, { imported_revision: undefined }, { imported_revision: SITE_SHA }]) assert.throws(() => verifySiteSource({ ...metadata(target), ...patch }, target, config(), IMPORT_SHA));
  assert.throws(() => verifySiteSource(metadata('admin'), 'admin', config(), undefined));
});

test('homepage root provenance is mandatory; preview-base metadata cannot pass', () => {
  for (const base of [undefined, '/preview/', 'https://rsrs.rs']) assert.throws(() => verifySiteSource({ ...metadata('homepage'), base }, 'homepage', config(), IMPORT_SHA), /root-origin/);
});

test('in-memory provenance probes all four origins and real linked homepage assets', async () => {
  const fixture = mockHosted();
  await verifyHostedProvenance(fixture.request, fixture.cfg, IMPORT_SHA);
  assert.equal(fixture.seen.filter(url => url.endsWith('/build-info.json')).length, 3);
  for (const path of ['/assets/home.js', '/assets/home.css', '/logo.svg']) assert.ok(fixture.seen.includes(`${fixture.cfg.origins.homepage}${path}`));
  assert.ok(fixture.seen.every(url => !url.includes('rsrs.rs')));
});

test('missing or mismatched homepage metadata fails before homepage assets are accessed', async () => {
  for (const body of [{}, { ...metadata('homepage'), site_revision: SERVER_SHA }, { ...metadata('homepage'), source_tree_dirty: true }]) {
    const fixture = mockHosted();
    fixture.put(`${fixture.cfg.origins.homepage}/build-info.json`, body);
    await assert.rejects(() => verifyHostedProvenance(fixture.request, fixture.cfg, IMPORT_SHA));
    assert.ok(!fixture.seen.some(url => url.endsWith('/assets/home.js')));
  }
});

test('provenance probes fail closed for redirects and unexpected content types', async () => {
  for (const patch of [{ status: 302 }, { status: 404 }, { type: 'text/html' }, { finalUrl: 'https://api.rsrs.rs/health' }]) {
    const fixture = mockHosted();
    Object.assign(fixture.records.get(`${fixture.cfg.origins.api}/health`), patch);
    await assert.rejects(() => verifyHostedProvenance(fixture.request, fixture.cfg, IMPORT_SHA));
    assert.equal(fixture.seen.length, 1);
  }
});

test('homepage linked assets reject SPA fallback HTML even with status 200', async () => {
  for (const path of ['/assets/home.js', '/assets/home.css', '/logo.svg']) {
    const fixture = mockHosted();
    fixture.records.get(`${fixture.cfg.origins.homepage}${path}`).type = 'text/html';
    await assert.rejects(() => verifyHostedProvenance(fixture.request, fixture.cfg, IMPORT_SHA), /content type/);
  }
});

test('homepage missing assets, cross-origin assets, and asset redirects fail closed', async () => {
  for (const html of ['<html>missing assets</html>', '<script src="https://api.rsrs.rs/assets/app.js"></script>', '<script src="https://user:pass@homepage.test.invalid/app.js"></script>']) {
    const fixture = mockHosted();
    fixture.put(`${fixture.cfg.origins.homepage}/`, html, 'text/html');
    await assert.rejects(() => verifyHostedProvenance(fixture.request, fixture.cfg, IMPORT_SHA));
    assert.ok(!fixture.seen.some(url => url.includes('api.rsrs.rs') || url.includes('user:pass')));
  }
  const fixture = mockHosted();
  fixture.records.get(`${fixture.cfg.origins.homepage}/assets/home.js`).status = 302;
  await assert.rejects(() => verifyHostedProvenance(fixture.request, fixture.cfg, IMPORT_SHA), /redirected/);
});

test('browser restrictions allow only configured origins and send API activity only to the API origin', () => {
  const cfg = config();
  const request = (url, method = 'GET', headers = {}) => ({ url, method, headers });
  for (const resource of ['Fetch', 'XHR', 'Preflight']) {
    assert.equal(requestViolation(cfg, request(`${cfg.origins.api}/api/self`), resource), null);
    for (const target of ['dashboard', 'admin', 'homepage']) assert.equal(requestViolation(cfg, request(`${cfg.origins[target]}/api/self`), resource), 'api-request-to-frontend-origin');
  }
  for (const origin of Object.values(cfg.origins)) assert.equal(requestViolation(cfg, request(`${origin}/`), 'Document'), null);
  assert.equal(requestViolation(cfg, request(`${cfg.origins.admin}/admin/security`), 'Document'), null);
  assert.equal(requestViolation(cfg, request(`${cfg.origins.admin}/admin/me`, 'POST'), 'Other'), 'api-request-to-frontend-origin');
  assert.equal(requestViolation(cfg, request(`${cfg.origins.admin}/`, 'GET', { aUtHoRiZaTiOn: 'unit-only' }), 'Document'), 'api-request-to-frontend-origin');
  for (const url of ['https://api.rsrs.rs/login', 'https://other.test.invalid/', 'https://name:pass@api.test.invalid/', 'wss://api.test.invalid/', 'file:///tmp/fixture']) assert.equal(requestViolation(cfg, request(url), 'Document'), 'unapproved-origin');
});

test('live smoke and IMAP namespace adaptations are recorded in provenance', async () => {
  const upstream = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
  for (const path of ['tests/browser-dev-smoke.mjs', 'scripts/read-dev-mail.py']) {
    assert.ok(upstream.intentionally_adapted.includes(path));
    assert.equal(upstream.unchanged_sha256[path], undefined);
  }
});

test('hosted adaptation retains every strict legacy user/admin acceptance step', async () => {
  const legacy = await readFile(new URL('./browser-dev-smoke.mjs', import.meta.url), 'utf8');
  const hosted = await readFile(new URL('./browser-hosted-split-smoke.mjs', import.meta.url), 'utf8');
  const names = source => [...source.matchAll(/await step\('([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(names(hosted).slice(3).filter(name => name !== 'admin-daily-stats-ranges-history-and-responsive-readback'), names(legacy).slice(2));
  assert.ok(names(hosted).includes('admin-daily-stats-ranges-history-and-responsive-readback'));
  assert.ok(hosted.includes('verifyCheckoutSource(checkoutSha, checkoutStatus, config)'));
  assert.ok(hosted.includes('await verifyHostedProvenance(context.request, config, upstream.commit)'));
  const guard = await readFile(new URL('./hosted-browser-guard.mjs', import.meta.url), 'utf8');
  assert.ok(hosted.includes('installHostedBrowserGuard({ context, page, config, failures: networkFailures })'));
  assert.ok(guard.includes('interceptResponse: true'));
  assert.ok(guard.includes("'redirect-blocked'"));
  assert.ok(!guard.includes('context.route('));
  assert.ok(!guard.includes('page.route('));
});
