import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { api, onUnauthorized } from '../src/api.js';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; onUnauthorized(null); });
test('JSON and bearer tokens go to API origin without cookies', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.rsrs.rs/login');
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert.deepEqual(options.headers, { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' });
    assert.equal(options.method, 'POST'); assert.equal(options.body, '{"user":"fixture"}');
    return new Response('{"token":"fixture-response"}', { status: 200 });
  };
  assert.deepEqual(await api('/login', { method: 'POST', token: 'fixture-token', body: { user: 'fixture' } }), { token: 'fixture-response' });
});
test('401 callback retains logical path and originating token', async () => {
  const calls = []; onUnauthorized((...args) => calls.push(args));
  globalThis.fetch = async () => new Response('{"error":"expired"}', { status: 401 });
  await assert.rejects(api('/api/self', { token: 'stale-fixture' }), err => err.status === 401 && err.body.error === 'expired');
  assert.deepEqual(calls, [['/api/self', 'stale-fixture']]);
});
test('admin token-required response invalidates while role denial does not', async () => {
  const calls = []; onUnauthorized((...args) => calls.push(args));
  globalThis.fetch = async () => new Response('{"error":"admin token required"}', { status: 403 });
  await assert.rejects(api('/admin/me', { token: 'wrong-fixture' }), { status: 403 });
  assert.deepEqual(calls, [['/admin/me', 'wrong-fixture']]);
  globalThis.fetch = async () => new Response('{"error":"owner role required"}', { status: 403 });
  await assert.rejects(api('/admin/admins', { token: 'viewer-fixture' }), { status: 403 }); assert.equal(calls.length, 1);
});
test('network, rate limit, and non-JSON error responses remain visible', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; await assert.rejects(api('/api/self'), /Failed to fetch/);
  globalThis.fetch = async () => new Response('{"error":"rate limited"}', { status: 429 }); await assert.rejects(api('/login'), { status: 429, message: 'rate limited' });
  globalThis.fetch = async () => new Response('Service unavailable', { status: 503 }); await assert.rejects(api('/api/self'), { status: 503, message: 'Service unavailable' });
});
