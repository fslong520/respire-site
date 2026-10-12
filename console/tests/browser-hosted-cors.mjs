import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { installHostedBrowserGuard } from './hosted-browser-guard.mjs';

// Local regression for the exact hosted guard. No hosted configuration, secrets,
// mail helper, real account, DNS destination, or environment API URL is consumed.
// Only literal 127.0.0.1 ephemeral HTTP fixtures are ever requested by the page.
const servers = [];
const records = [];
let blockedRequests = 0;
let browser;
let context;
let guard;
const cases = [];
async function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
const html = (_request, response) => response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Isolated CORS fixture</title><h1>Local fixture</h1>');

try {
  const origins = {};
  for (const target of ['dashboard', 'admin', 'homepage']) origins[target] = await listen(html);
  const blockedOrigin = await listen((_request, response) => {
    blockedRequests += 1;
    response.writeHead(200).end('Unexpected destination');
  });
  origins.api = await listen((request, response) => {
    const origin = request.headers.origin;
    const allowed = [origins.dashboard, origins.admin].includes(origin);
    const headers = {
      'Content-Type': 'application/json', 'Vary': 'Origin',
      ...(allowed ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'authorization, content-type' } : {}),
    };
    records.push({ method: request.method, path: request.url, headers: request.headers, sentHeaders: headers });
    if (request.method === 'OPTIONS') return response.writeHead(204, headers).end();
    if (request.url === '/redirect') return response.writeHead(302, { ...headers, Location: `${blockedOrigin}/landing` }).end();
    response.writeHead(401, headers).end('{"error":"synthetic token rejected"}');
  });
  const config = { origins };
  assert.equal(new Set(Object.values(origins)).size, 4);
  browser = await chromium.launch({ headless: true, ...(process.env.RSRS_BROWSER_EXECUTABLE ? { executablePath: process.env.RSRS_BROWSER_EXECUTABLE } : {}) });

  // Baseline proves the fixture's native CORS behavior. Protected mode imports
  // the actual hosted harness guard, including raw CDP request/response handling.
  // Do not replace this with context.route/page.route: Playwright 1.63 can
  // synthesize successful OPTIONS responses when request routing is enabled.
  for (const mode of ['native-baseline', 'hosted-direct-cdp']) {
    for (const target of ['dashboard', 'admin', 'homepage']) {
      const failures = [];
      context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      guard = mode === 'hosted-direct-cdp'
        ? await installHostedBrowserGuard({ context, page, config, failures }) : undefined;
      await page.goto(`${origins[target]}/`);
      const start = records.length;
      const results = await page.evaluate(async apiOrigin => {
        const outcomes = [];
        for (const [path, init] of [
          ['/auth', { method: 'GET', headers: { Authorization: 'Bearer synthetic-only-invalid-token' } }],
          ['/json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"fixture":true}' }],
        ]) {
          try {
            const response = await fetch(`${apiOrigin}${path}`, { ...init, credentials: 'omit', signal: AbortSignal.timeout(5000) });
            outcomes.push({ readable: true, status: response.status, body: await response.json() });
          } catch { outcomes.push({ readable: false }); }
        }
        return outcomes;
      }, origins.api);
      const seen = records.slice(start);
      const allowed = target !== 'homepage';
      for (const [path, method, header] of [['/auth', 'GET', 'authorization'], ['/json', 'POST', 'content-type']]) {
        const preflight = seen.filter(record => record.method === 'OPTIONS' && record.path === path);
        assert.equal(preflight.length, 1, `${mode}/${target}: actual server must receive one OPTIONS for ${path}`);
        assert.equal(preflight[0].headers.origin, origins[target]);
        assert.equal(preflight[0].headers['access-control-request-method'], method);
        assert.ok(preflight[0].headers['access-control-request-headers'].split(',').map(value => value.trim()).includes(header));
        assert.equal(preflight[0].sentHeaders.Vary, 'Origin');
        assert.equal(preflight[0].sentHeaders['Access-Control-Allow-Origin'], allowed ? origins[target] : undefined);
        assert.equal(seen.filter(record => record.method === method && record.path === path).length, allowed ? 1 : 0,
          `${mode}/${target}: denied preflight must prevent the actual request`);
      }
      if (allowed) {
        assert.deepEqual(results, [
          { readable: true, status: 401, body: { error: 'synthetic token rejected' } },
          { readable: true, status: 401, body: { error: 'synthetic token rejected' } },
        ]);
      } else assert.deepEqual(results, [{ readable: false }, { readable: false }]);
      assert.deepEqual(failures, [], `${mode}/${target}: unexpected guard failure`);
      cases.push(`${mode}/${target}`);
      console.log(`PASS ${mode}/${target}: actual OPTIONS and ${allowed ? 'readable 401' : 'denied CORS'}`);
      guard?.beginClosing();
      await context.close();
      context = undefined;
      guard = undefined;
    }
  }

  // The same protected path must still prevent credential-bearing redirects and
  // unapproved destinations. The blocked target is another local fixture, so a
  // regression is observable without ever contacting an external service.
  const failures = [];
  context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  guard = await installHostedBrowserGuard({ context, page, config, failures });
  await page.goto(`${origins.dashboard}/`);
  const results = await page.evaluate(async ({ api, blocked }) => {
    const outcomes = [];
    for (const url of [`${api}/redirect`, `${blocked}/direct`]) {
      try {
        await fetch(url, { headers: { Authorization: 'Bearer synthetic-only-invalid-token' }, credentials: 'omit', signal: AbortSignal.timeout(5000) });
        outcomes.push('unexpected-success');
      } catch { outcomes.push('blocked'); }
    }
    return outcomes;
  }, { api: origins.api, blocked: blockedOrigin });
  assert.deepEqual(results, ['blocked', 'blocked']);
  assert.equal(blockedRequests, 0, 'Redirect or unapproved request reached the blocked fixture');
  assert.ok(failures.includes('redirect-blocked'));
  assert.ok(failures.includes('unapproved-origin'));
  assert.ok(!failures.includes('interception-failed'));
  console.log('PASS hosted-direct-cdp: redirects and unapproved origins blocked before contact');
  console.log(`PASS all ${cases.length} local CORS combinations and hosted network boundaries`);
} finally {
  guard?.beginClosing();
  await context?.close();
  await browser?.close();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
