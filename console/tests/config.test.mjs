import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiUrl, normalizeApiBase } from '../src/config.js';
test('production API is direct and configured as a public origin', () => {
  assert.equal(apiUrl('/api/self'), 'https://api.rsrs.rs/api/self');
  assert.equal(apiUrl('/admin/users?q=alice%40example.invalid', 'https://api-test.example/'), 'https://api-test.example/admin/users?q=alice%40example.invalid');
  assert.equal(apiUrl('/login', 'http://127.0.0.1:4000'), 'http://127.0.0.1:4000/login');
  assert.equal(normalizeApiBase('http://localhost:4000/'), 'http://localhost:4000');
});
test('reject accidental credentials, paths and nonsecure remote API destinations', () => {
  for (const value of ['', '/api', 'https://user:password@api.example', 'https://api.example/v1', 'https://api.example/?token=secret', 'https://api.example/#secret', 'http://api.example', 'file:///tmp/api']) assert.throws(() => normalizeApiBase(value), /VITE_API_BASE_URL/);
  for (const path of ['https://other.example/login', '//other.example/login', '/\\other.example/login', 'login']) assert.throws(() => apiUrl(path), /logical absolute path/);
});
