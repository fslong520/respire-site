import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { startFixtureProxy } from './fixture-proxy.mjs';

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function proxyFor(t, destinations) {
  const proxy = await startFixtureProxy(destinations);
  t.after(() => proxy.close());
  return proxy;
}

function through(proxy, target, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(proxy.origin);
  let host = 'fixture.invalid';
  try { host = new URL(target).host; } catch { /* Test malformed proxy targets. */ }
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port: url.port, method, path: target,
      headers: { Host: host, ...headers }, agent: false,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on('connect', (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode, headers: response.headers, body: '' });
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('proxy configuration admits only exact, explicit loopback origins and methods', async () => {
  for (const origin of ['https://127.0.0.1:12345', 'http://example.invalid:12345', 'http://localhost:12345', 'http://127.0.0.1', 'http://127.0.0.1:12345/path', 'http://user:pass@127.0.0.1:12345', 'http://127.0.0.1:12345/']) {
    await assert.rejects(startFixtureProxy([{ origin, methods: ['GET'] }]), /exact HTTP 127/);
  }
  await assert.rejects(startFixtureProxy([]), /explicitly/);
  await assert.rejects(startFixtureProxy([{ origin: 'http://127.0.0.1:12345', methods: ['CONNECT'] }]), /subset/);
  await assert.rejects(startFixtureProxy([{ origin: 'http://127.0.0.1:12345', methods: [] }]), /subset/);
});

test('proxy forwards method, URL, JSON, bearer/Origin headers, status, and CORS response unchanged', async t => {
  const received = [];
  const origin = await fixture(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ method: request.method, path: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() });
    response.writeHead(request.method === 'OPTIONS' ? 204 : 201, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': request.headers.origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      Vary: 'Origin',
    });
    response.end(request.method === 'OPTIONS' ? undefined : '{"ok":true}');
  });
  const proxy = await proxyFor(t, [{ origin, methods: ['GET', 'POST', 'OPTIONS'] }]);
  const uiOrigin = 'http://127.0.0.1:23456';
  const preflight = await through(proxy, `${origin}/api/self`, { method: 'OPTIONS', headers: {
    Origin: uiOrigin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], uiOrigin);
  assert.equal(preflight.headers.vary, 'Origin');
  const payload = '{"synthetic":true}';
  const posted = await through(proxy, `${origin}/push?since=1`, { method: 'POST', body: payload, headers: {
    Origin: uiOrigin, Authorization: 'Bearer fixture-only', 'Content-Type': 'application/json',
    'Proxy-Authorization': 'must-not-forward', 'Proxy-Connection': 'keep-alive',
  } });
  assert.equal(posted.status, 201);
  assert.equal(posted.body, '{"ok":true}');
  assert.equal(received[0].headers['access-control-request-method'], 'GET');
  assert.equal(received[0].headers['access-control-request-headers'], 'authorization');
  assert.equal(received[1].method, 'POST');
  assert.equal(received[1].path, '/push?since=1');
  assert.equal(received[1].body, payload);
  assert.equal(received[1].headers.authorization, 'Bearer fixture-only');
  assert.equal(received[1].headers.origin, uiOrigin);
  assert.equal(received[1].headers['content-type'], 'application/json');
  assert.equal(received[1].headers['proxy-authorization'], undefined);
  assert.equal(received[1].headers['proxy-connection'], undefined);
  assert.deepEqual(proxy.blocked, []);
  assert.deepEqual(proxy.errors, []);
  assert.deepEqual(proxy.requests.map(({ method, path }) => ({ method, path })), [{ method: 'OPTIONS', path: '/api/self' }, { method: 'POST', path: '/push' }]);
});

test('proxy denies other origins, ports, schemes, malformed URLs, credentials, and mismatched Host before connecting', async t => {
  let received = 0;
  const origin = await fixture(t, (_, response) => { received++; response.end('should not be reached'); });
  const unapproved = await fixture(t, (_, response) => { received++; response.end('should not be reached'); });
  const proxy = await proxyFor(t, [{ origin, methods: ['GET'] }]);
  const targets = [
    'http://example.invalid/data', 'https://example.invalid/data', `${unapproved}/data`,
    origin.replace('127.0.0.1', 'localhost') + '/data', '/relative-path',
    origin.replace('http://', 'http://user:password@') + '/data', `${origin}/data#fragment`,
  ];
  for (const target of targets) assert.equal((await through(proxy, target)).status, 403, target);
  assert.equal((await through(proxy, `${origin}/data`, { headers: { Host: 'different.invalid' } })).status, 403);
  assert.equal(received, 0);
  assert.equal(proxy.requests.length, 0);
  assert.equal(proxy.blocked.length, targets.length + 1);
});

test('proxy enforces the method allowlist separately for each origin', async t => {
  const received = [];
  const handler = (request, response) => { received.push(request.method); response.end('fixture'); };
  const ui = await fixture(t, handler);
  const api = await fixture(t, handler);
  const proxy = await proxyFor(t, [{ origin: ui, methods: ['GET'] }, { origin: api, methods: ['GET', 'POST', 'OPTIONS'] }]);
  for (const method of ['POST', 'OPTIONS', 'PUT', 'DELETE', 'PATCH']) assert.equal((await through(proxy, `${ui}/`, { method })).status, 403);
  for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD']) assert.equal((await through(proxy, `${api}/`, { method })).status, 403);
  assert.deepEqual(received, []);
  assert.equal((await through(proxy, `${ui}/`)).status, 200);
  assert.equal((await through(proxy, `${api}/`, { method: 'POST', body: 'fixture' })).status, 200);
  assert.deepEqual(received, ['GET', 'POST']);
});

test('proxy denies CONNECT tunnels and WebSocket upgrades even to approved fixtures', async t => {
  let received = 0;
  const origin = await fixture(t, (_, response) => { received++; response.end('unexpected'); });
  const proxy = await proxyFor(t, [{ origin, methods: ['GET'] }]);
  for (const target of ['example.invalid:443', new URL(origin).host]) assert.equal((await through(proxy, target, { method: 'CONNECT' })).status, 403);
  assert.equal((await through(proxy, `${origin}/socket`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket' } })).status, 403);
  assert.equal(received, 0);
  assert.equal(proxy.requests.length, 0);
  assert.deepEqual(proxy.blocked.map(row => row.reason), ['connect not allowed', 'connect not allowed', 'upgrade not allowed']);
});

test('proxy does not follow upstream redirects to non-fixture services', async t => {
  const origin = await fixture(t, (_, response) => response.writeHead(302, { Location: 'https://example.invalid/never-contact' }).end());
  const proxy = await proxyFor(t, [{ origin, methods: ['GET'] }]);
  const result = await through(proxy, `${origin}/`);
  assert.equal(result.status, 302);
  assert.equal(result.headers.location, 'https://example.invalid/never-contact');
  assert.equal((await through(proxy, result.headers.location)).status, 403);
  assert.equal(proxy.requests.length, 1);
  assert.equal(proxy.blocked.length, 1);
});

test('proxy returns a visible 502 for a failed approved upstream', async t => {
  const origin = await fixture(t, (_, response) => response.destroy());
  const proxy = await proxyFor(t, [{ origin, methods: ['GET'] }]);
  const result = await through(proxy, `${origin}/`);
  assert.equal(result.status, 502);
  assert.match(result.body, /upstream unavailable/);
  assert.equal(proxy.errors.length, 1);
  assert.equal(proxy.errors[0].origin, origin);
  assert.deepEqual(proxy.blocked, []);
});

test('normal browser-context cancellation does not become a proxy transport failure', async t => {
  let onReceived;
  let onClosed;
  const received = new Promise(resolve => { onReceived = resolve; });
  const closed = new Promise(resolve => { onClosed = resolve; });
  const origin = await fixture(t, (_, response) => {
    response.on('close', onClosed);
    onReceived();
    // Keep the response pending, like a fetch cancelled by context.close().
  });
  const proxy = await proxyFor(t, [{ origin, methods: ['GET'] }]);
  const request = httpRequest({ hostname: '127.0.0.1', port: new URL(proxy.origin).port,
    path: `${origin}/pending`, headers: { Host: new URL(origin).host }, agent: false });
  request.on('error', () => {}); // The client deliberately abandons this request.
  request.end();
  await received;
  request.destroy();
  await closed;
  assert.deepEqual(proxy.errors, []);
  assert.deepEqual(proxy.blocked, []);
});
