import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';

const METHODS = new Set(['GET', 'POST', 'OPTIONS']);
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function forwardedHeaders(headers) {
  const connectionHeaders = new Set(String(headers.connection || '').toLowerCase().split(',').map(value => value.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name) && !connectionHeaders.has(name)));
}

/**
 * Fail-closed, fixture-only HTTP proxy. A normal network proxy leaves Chromium's
 * native CORS checks intact; Playwright's route handler synthesizes preflights.
 * Forwarding always uses the literal loopback IP, so rejected targets never
 * trigger DNS resolution or any connection to a live service.
 */
export async function startFixtureProxy(destinations) {
  assert.ok(Array.isArray(destinations) && destinations.length > 0, 'Specify fixture destinations explicitly');
  const allowed = new Map();
  for (const { origin, methods } of destinations) {
    const url = new URL(origin);
    assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && origin === url.origin,
      'Fixture proxy destinations must be exact HTTP 127.0.0.1 origins with explicit ports');
    assert.ok(Array.isArray(methods) && methods.length && methods.every(method => METHODS.has(method)),
      'Fixture proxy methods must be an explicit subset of GET, POST, OPTIONS');
    assert.ok(!allowed.has(origin), 'Duplicate fixture proxy origin');
    allowed.set(origin, new Set(methods));
  }
  const requests = [];
  const blocked = [];
  const errors = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    function deny(reason) {
      blocked.push({ method: request.method, target: request.url, reason });
      request.resume();
      response.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' }).end('Fixture proxy denied request\n');
    }
    let url;
    try { url = new URL(request.url); } catch { return deny('absolute URL required'); }
    if (url.protocol !== 'http:' || url.username || url.password || url.hash) return deny('unsupported URL');
    if (!allowed.has(url.origin)) return deny('origin not allowed');
    if (!allowed.get(url.origin).has(request.method)) return deny('method not allowed');
    if (request.headers.host !== url.host) return deny('Host header does not match allowed origin');
    requests.push({ method: request.method, origin: url.origin, path: url.pathname, search: url.search });
    let clientGone = false;
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: request.method,
      headers: { ...forwardedHeaders(request.headers), host: url.host },
      agent: false,
    }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode, forwardedHeaders(upstreamResponse.headers));
      upstreamResponse.on('error', fail);
      upstreamResponse.pipe(response);
    });
    function fail(error) {
      if (clientGone) return;
      errors.push({ method: request.method, origin: url.origin, path: url.pathname, code: error.code });
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain', Connection: 'close' });
      response.end('Fixture proxy upstream unavailable\n');
    }
    upstream.on('error', fail);
    const cancel = () => { clientGone = true; upstream.destroy(); };
    request.on('aborted', cancel);
    request.on('error', cancel);
    response.on('close', () => { if (!response.writableEnded) cancel(); });
    request.pipe(upstream);
  });
  // HTTPS tunnelling and WebSocket upgrades are never needed by these fixtures.
  for (const event of ['connect', 'upgrade']) server.on(event, (request, socket) => {
    blocked.push({ method: request.method, target: request.url, reason: `${event} not allowed` });
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.on('clientError', (error, socket) => {
    // Chromium closes idle/preconnected sockets when a context is disposed.
    // A connection reset is not an HTTP parser rejection; parsed requests still
    // pass the origin/method checks above before any upstream connection.
    if (error.code === 'ECONNRESET') { socket.destroy(); return; }
    blocked.push({ method: null, target: null, reason: `malformed HTTP: ${error.code}` });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    blocked,
    errors,
    async close() {
      // Include upgraded sockets, which closeAllConnections does not close.
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
