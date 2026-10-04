import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consoleRoute } from '../src/consoleRoute.js';
test('each explicit build owns its root and own legacy entry only', () => {
  for (const target of ['dashboard', 'admin']) {
    for (const path of ['/', `/${target}`, `/${target}/`]) assert.deepEqual(consoleRoute(path, target), { supported: true, canonical: null });
    const other = target === 'dashboard' ? 'admin' : 'dashboard';
    assert.equal(consoleRoute(`/${other}`, target).supported, false);
    assert.equal(consoleRoute(`/${other}/security`, target).supported, false);
    assert.equal(consoleRoute('/unknown', target).supported, false);
  }
  assert.throws(() => consoleRoute('/', 'automatic'), /Unknown/);
});
test('legacy nested paths canonicalize once and preserve hash navigation', () => {
  assert.equal(consoleRoute('/dashboard/memories/a%2Fb/', 'dashboard').canonical, '/dashboard#/memories/a%2Fb');
  assert.equal(consoleRoute('/admin/users', 'admin').canonical, '/admin#/users');
  assert.equal(consoleRoute('/dashboard/memories/a', 'dashboard', '#/diary').canonical, '/dashboard#/diary');
});
