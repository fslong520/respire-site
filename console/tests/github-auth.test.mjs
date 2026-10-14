import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubCallback } from '../src/githubAuth.js';

function browser(pending, search) {
  const values = new Map(pending ? [['respire.githubAuthorization', JSON.stringify(pending)]] : []);
  const storage = { getItem: key => values.get(key), removeItem: key => values.delete(key) };
  return { storage, location: { search }, values };
}

test('GitHub callback preserves CLI approval route and consumes browser state once', () => {
  const pending = { state: 'a'.repeat(64), expires: Date.now() + 60000, bind: false, hash: '#/authorize?code=ABCDEF123456' };
  const { location, storage, values } = browser(pending, `?code=temporary-code&state=${pending.state}`);
  assert.deepEqual(githubCallback(location, storage), { state: pending.state, code: 'temporary-code', bind: false, hash: pending.hash });
  assert.equal(values.size, 0);
  assert.match(githubCallback(location, storage).error, /does not match/);
});

test('uninitiated, mismatched and expired callbacks cannot log in or bind', () => {
  for (const pending of [null, { state: 'other', expires: Date.now() + 60000 }, { state: 'state', expires: 0 }, { state: 'state' }]) {
    const { location, storage } = browser(pending, '?code=code&state=state');
    const reply = githubCallback(location, storage);
    assert.match(reply.error, /does not match/);
    assert.equal(reply.code, undefined);
  }
});

test('denial preserves the original route without exchanging a code', () => {
  const { location, storage } = browser({ state: 'state', expires: Date.now() + 60000, bind: true, hash: '#/security' }, '?error=access_denied&state=state');
  assert.deepEqual(githubCallback(location, storage), { error: 'GitHub authorization was cancelled.', hash: '#/security' });
});

test('ordinary dashboard queries are not consumed as GitHub callbacks', () => {
  const { storage, values } = browser({ state: 'state' }, '');
  assert.equal(githubCallback({ search: '?search=memory' }, storage), null);
  assert.equal(values.size, 1);
});
