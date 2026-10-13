import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { createTrustedKeyStore } from '../src/trustedKeyStore.js';

const context = (overrides = {}) => ({ account_id: 'account-a', rp_id: 'dashboard.example.test',
  device_id: '10000000-0000-4000-8000-000000000001', key_generation: 1, ...overrides });
const device = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const clone = value => value === undefined ? undefined : structuredClone(value);
const abortError = error => error?.name === 'AbortError';
const code = expected => error => error?.code === expected;

// A small request/transaction fake, not a replacement for the real-browser IDB
// suite. It structured-clones keys, serializes transactions, and rolls aborted
// writes back. Separate factory objects model independent page-local fences
// while sharing the same durable database.
function idbHarness() {
  const engine = { stores: new Map(), transactions: [], connections: [], active: null,
    failOpen: false, blocked: false, failWrites: false, transformRead: null, beforeCommit: null };
  const next = () => {
    if (engine.active) return;
    const tx = engine.transactions.shift();
    if (!tx) return;
    engine.active = tx;
    tx.start();
  };
  const complete = tx => {
    if (engine.active === tx) engine.active = null;
    else engine.transactions = engine.transactions.filter(item => item !== tx);
    next();
  };
  function makeTransaction(names, mode) {
    let snapshot, finished = false, started = false, committing = false;
    const queue = [];
    const tx = { mode, error: null, mutated: false,
      start() {
        if (finished) { complete(tx); return; }
        started = true;
        snapshot = new Map(names.map(name => [name, new Map([...engine.stores.get(name)].map(([key, value]) => [key, clone(value)]))]));
        setImmediate(tick);
      },
      objectStore(name) {
        if (!names.includes(name)) throw new DOMException('Missing object store', 'NotFoundError');
        const request = (action, writable = false) => {
          if (finished) throw new DOMException('Inactive transaction', 'TransactionInactiveError');
          const req = {};
          queue.push({ req, writable, action: () => action(snapshot.get(name)) });
          return req;
        };
        return {
          get: key => request(data => {
            const result = clone(data.get(key));
            return name === 'keys' && engine.transformRead ? engine.transformRead(result) : result;
          }),
          getAll: () => request(data => [...data.values()].map(clone)),
          add: value => request(data => {
            if (data.has(value.id)) throw new DOMException('Duplicate key', 'ConstraintError');
            data.set(value.id, clone(value)); return value.id;
          }, true),
          put: value => request(data => { data.set(value.id, clone(value)); return value.id; }, true),
          delete: key => request(data => { data.delete(key); }, true),
          clear: () => request(data => { data.clear(); }, true),
        };
      },
      abort() {
        if (finished) throw new DOMException('Finished transaction', 'InvalidStateError');
        finished = true;
        setImmediate(() => tx.onabort?.());
        complete(tx);
      },
    };
    async function tick() {
      if (finished || !started || committing) return;
      const item = queue.shift();
      if (item) {
        try {
          if (item.writable) {
            if (mode !== 'readwrite') throw new DOMException('Read only', 'ReadOnlyError');
            if (engine.failWrites) throw new DOMException('Quota', 'QuotaExceededError');
            tx.mutated = true;
          }
          item.req.result = item.action();
          item.req.onsuccess?.();
        } catch (error) {
          item.req.error = tx.error = error;
          item.req.onerror?.();
          if (!finished) { tx.onerror?.(); if (!finished) tx.abort(); }
        }
        setImmediate(tick);
        return;
      }
      committing = true;
      await engine.beforeCommit?.(tx);
      if (finished) return;
      if (mode === 'readwrite') for (const [name, data] of snapshot) engine.stores.set(name, data);
      finished = true;
      tx.oncomplete?.();
      complete(tx);
    }
    engine.transactions.push(tx); next();
    return tx;
  }
  const newFactory = () => ({ open() {
    const request = {};
    setImmediate(() => {
      if (engine.failOpen) { request.error = new DOMException('Denied', 'SecurityError'); request.onerror?.(); return; }
      if (engine.blocked) { request.onblocked?.(); return; }
      const db = { closed: false,
        objectStoreNames: { contains: name => engine.stores.has(name) },
        createObjectStore: name => { engine.stores.set(name, new Map()); },
        close() { db.closed = true; },
        transaction(names, mode) {
          if (db.closed) throw new DOMException('Closed', 'InvalidStateError');
          return makeTransaction(Array.isArray(names) ? names : [names], mode);
        },
      };
      engine.connections.push(db); request.result = db;
      if (!engine.stores.size) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  } });
  return { engine, newFactory, records: () => [...(engine.stores.get('keys')?.values() || [])] };
}
function harness(options = {}) {
  const db = idbHarness(), indexedDB = db.newFactory();
  return { ...db, indexedDB, store: createTrustedKeyStore({ indexedDB, crypto: webcrypto, ...options }) };
}
function delayedCrypto(method) {
  const entered = defer(), release = defer();
  let delayed = false;
  const subtle = new Proxy(webcrypto.subtle, { get(target, key) {
    if (key === method) return async (...args) => {
      if (!delayed) { delayed = true; entered.resolve(); await release.promise; }
      return target[key](...args);
    };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { crypto: { subtle, getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }, entered, release };
}

test('creates a random, nonexportable AES-GCM key and returns a persisted readback', async () => {
  const { store, records } = harness();
  const ctx = context();
  const key = await store.create({ ...ctx, token: 'NEVER-PERSIST', urk: 'NEVER-PERSIST', wrapped_urk: 'NEVER-PERSIST', prf: 'NEVER-PERSIST' });
  assert.equal(key.type, 'secret'); assert.equal(key.extractable, false);
  assert.deepEqual(key.algorithm, { name: 'AES-GCM', length: 256 });
  assert.deepEqual(key.usages, ['encrypt', 'decrypt']);
  await assert.rejects(webcrypto.subtle.exportKey('raw', key));
  const loaded = await store.read(ctx);
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, new Uint8Array([4, 8, 15]));
  assert.deepEqual(new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, loaded, ciphertext)), new Uint8Array([4, 8, 15]));
  assert.equal(JSON.stringify(records()).includes('NEVER-PERSIST'), false);
  assert.deepEqual(Object.keys(records()[0]).sort(), ['account_id', 'active', 'device_id', 'id', 'key', 'key_generation', 'revision', 'rp_id']);
  const listed = await store.list(ctx);
  assert.equal(listed.length, 1); assert.equal('key' in listed[0], false);
  assert.equal(listed[0].active, false);
});

test('identity is stable account/RP/device/generation, never a login token', async () => {
  const { store } = harness();
  await store.create(context());
  assert.ok(await store.read({ ...context(), token: 'rotated-token' }));
  assert.equal(await store.read(context({ account_id: 'account-b' })), null);
  assert.equal(await store.read(context({ rp_id: 'other.example.test' })), null);
  assert.equal(await store.read(context({ device_id: device(2) })), null);
  assert.equal(await store.read(context({ key_generation: 2 })), null);
  await assert.rejects(store.create(context()), code('trustedBrowserKeyExists'));
  assert.ok(await store.read(context()));
});

test('bad contexts and malformed key metadata fail closed', async () => {
  const { store, engine } = harness();
  await assert.rejects(store.create(context({ device_id: 'not-a-uuid' })), code('trustedBrowserKeyInvalid'));
  await assert.rejects(store.create(context({ key_generation: 0 })), code('trustedBrowserKeyInvalid'));
  await assert.rejects(store.create(context({ rp_id: 'https://example.test' })), code('trustedBrowserKeyInvalid'));
  await store.create(context());
  for (const patch of [{ type: 'public' }, { extractable: true }, { algorithm: { name: 'AES-GCM', length: 128 } },
    { algorithm: { name: 'AES-CBC', length: 256 } }, { usages: ['encrypt'] }, { usages: ['encrypt', 'decrypt', 'wrapKey'] }]) {
    engine.transformRead = record => record && { ...record, key: { type: 'secret', extractable: false,
      algorithm: { name: 'AES-GCM', length: 256 }, usages: ['encrypt', 'decrypt'], ...patch } };
    await assert.rejects(store.read(context()), code('trustedBrowserKeyInvalid'));
  }
  engine.transformRead = record => record && { ...record, account_id: 'different-account' };
  await assert.rejects(store.read(context()), code('trustedBrowserKeyInvalid'));
});

test('persisted readback must decrypt ciphertext made by the newly generated key', async () => {
  const { store, engine, records } = harness();
  const different = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  engine.transformRead = record => record && { ...record, key: different };
  await assert.rejects(store.create(context()), code('trustedBrowserKeyInvalid'));
  assert.equal(records().length, 0);
});

test('unavailable, blocked, and failed writes reject without returning a key', async () => {
  for (const option of ['failOpen', 'blocked', 'failWrites']) {
    const { store, engine, records } = harness(); engine[option] = true;
    await assert.rejects(store.create(context()), code('trustedBrowserStorageUnavailable'));
    assert.equal(records().length, 0);
  }
  const missing = createTrustedKeyStore({ indexedDB: null, crypto: webcrypto });
  await assert.rejects(missing.read(context()), code('trustedBrowserStorageUnavailable'));
});

test('versionchange closes connection and permanently fails closed for this instance', async () => {
  const { store, engine } = harness(); await store.create(context());
  engine.connections[0].onversionchange();
  assert.equal(engine.connections[0].closed, true);
  await assert.rejects(store.read(context()), code('trustedBrowserStorageUnavailable'));
});

test('logout synchronously fences create still generating its key and clears only its account', async () => {
  const delay = delayedCrypto('generateKey');
  const { store, indexedDB, records } = harness({ crypto: delay.crypto });
  const other = createTrustedKeyStore({ indexedDB, crypto: webcrypto });
  await other.create(context({ account_id: 'account-b' }));
  const pending = store.create(context()); const rejected = assert.rejects(pending, abortError);
  await delay.entered.promise;
  const clearing = store.clearAccount('account-a');
  delay.release.resolve();
  await Promise.all([clearing, rejected]);
  assert.deepEqual(records().map(record => record.account_id), ['account-b']);
});

test('logout aborts a pending key write and prevents resurrection after cleanup', async () => {
  const { store, engine, records } = harness();
  const entered = defer(), release = defer(); let held = false;
  engine.beforeCommit = tx => {
    if (tx.mode === 'readwrite' && tx.mutated && !held) { held = true; entered.resolve(); return release.promise; }
  };
  const pending = store.create(context()); const rejected = assert.rejects(pending, abortError);
  await entered.promise;
  const clearing = store.clearAccount('account-a');
  release.resolve();
  await Promise.all([clearing, rejected]);
  assert.equal(records().length, 0);
});

test('independent page-local stores cannot insert after another tab logs out', async () => {
  for (const all of [false, true]) {
    const db = idbHarness(), delay = delayedCrypto('generateKey');
    const oldTab = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: delay.crypto });
    const logoutTab = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: webcrypto });
    const pending = oldTab.create(context()); const rejected = assert.rejects(pending, abortError);
    await delay.entered.promise;
    if (all) await logoutTab.clearAll(); else await logoutTab.clearAccount('account-a');
    delay.release.resolve();
    await rejected;
    assert.equal(db.records().length, 0);
  }
});

test('cross-tab logout also fences a key read paused in cryptographic validation', async () => {
  const db = idbHarness(), first = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: webcrypto });
  await first.create(context());
  const delay = delayedCrypto('encrypt');
  const second = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: delay.crypto });
  const pending = second.read(context()); const rejected = assert.rejects(pending, abortError);
  await delay.entered.promise; await first.clearAccount('account-a'); delay.release.resolve();
  await rejected;
});

test('failed account/all cleanup rejects and blocks later reads until cleanup succeeds', async () => {
  for (const all of [false, true]) {
    const { store, engine } = harness(); await store.create(context()); engine.failWrites = true;
    await assert.rejects(all ? store.clearAll() : store.clearAccount('account-a'), code('trustedBrowserStorageUnavailable'));
    await assert.rejects(store.read(context()), code('trustedBrowserStorageUnavailable'));
    engine.failWrites = false;
    if (all) await store.clearAll(); else await store.clearAccount('account-a');
    assert.equal(await store.read(context()), null);
  }
});

test('controller abort and stale callback are checked before returning persisted keys', async () => {
  const controller = new AbortController(); controller.abort();
  const { store } = harness();
  await assert.rejects(store.create(context(), { signal: controller.signal }), abortError);
  await store.create(context());
  await assert.rejects(store.read(context(), { isCurrent: () => false }), abortError);
});

test('aborting after persistence cleans up this uncommitted local enrollment', async () => {
  const delay = delayedCrypto('encrypt'), controller = new AbortController();
  const { store, records } = harness({ crypto: delay.crypto });
  const pending = store.create(context(), { signal: controller.signal }); const rejected = assert.rejects(pending, abortError);
  await delay.entered.promise; controller.abort(); delay.release.resolve();
  await rejected;
  assert.equal(records().length, 0);
});

test('reconcile keeps pending and new records, deletes only revision-matched active revocations', async () => {
  const { store } = harness();
  const active = context(), pending = context({ device_id: device(2) }), newer = context({ device_id: device(3) });
  await store.create(active); await store.markActive(active, 'credential_A'); await store.create(pending);
  const observedRecords = await store.list(active);
  await store.create(newer); await store.markActive(newer, 'credential_B');
  await store.reconcile(active, [], { observedRecords });
  const records = await store.list(active);
  assert.deepEqual(records.map(record => record.device_id), [pending.device_id, newer.device_id]);
  // Empty snapshot captured before activation must not remove that activation.
  const before = await store.list(active); await store.markActive(pending, 'credential_C');
  await store.reconcile(active, [], { observedRecords: before });
  assert.ok(await store.read(pending));
});

test('reconciliation without a pre-GET snapshot never deletes current active bindings', async () => {
  const { store } = harness(); await store.create(context()); await store.markActive(context(), 'credential_A');
  await store.reconcile(context(), []);
  assert.ok(await store.read(context()));
});

test('reconcile preserves allowed active records and unknown outcomes while pruning old generations', async () => {
  const { store } = harness();
  const old = context(), active = context({ key_generation: 2 }), pending = context({ key_generation: 2, device_id: device(2) });
  const future = context({ key_generation: 3 });
  await store.create(old); await store.create(active); await store.markActive(active, 'credential_A');
  await store.create(pending); await store.create(future);
  const observedRecords = await store.list(active);
  await store.reconcile(active, [active], { observedRecords });
  assert.deepEqual((await store.list(active)).map(record => record.key_generation), [2, 2, 3]);
});

test('durable generation floor prevents late old-generation insertion across tabs', async () => {
  const db = idbHarness(), delay = delayedCrypto('generateKey');
  const oldTab = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: delay.crypto });
  const resetTab = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: webcrypto });
  const pending = oldTab.create(context()); const rejected = assert.rejects(pending, abortError);
  await delay.entered.promise;
  await resetTab.create(context({ key_generation: 2 }));
  await resetTab.clearOlderGenerations(context(), 2);
  delay.release.resolve(); await rejected;
  assert.deepEqual(db.records().map(record => record.key_generation), [2]);
  // A stale floor update cannot lower the durable barrier.
  await resetTab.clearOlderGenerations(context(), 1);
  const freshTab = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: webcrypto });
  await assert.rejects(freshTab.create(context()), abortError);
});

test('revocation invalidates a cross-tab read and markActive rejects credential substitution', async () => {
  const db = idbHarness(), first = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: webcrypto });
  await first.create({ ...context(), credential_id: 'credential_A' });
  await assert.rejects(first.markActive(context(), 'credential_B'), code('trustedBrowserKeyInvalid'));
  const delay = delayedCrypto('encrypt'), second = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: delay.crypto });
  const pending = second.read(context()); const rejected = assert.rejects(pending, abortError);
  await delay.entered.promise; await first.remove(context()); delay.release.resolve(); await rejected;
  assert.equal(await first.read(context()), null);
});

test('old-generation cleanup preserves a newer enrollment already in progress in another tab', async () => {
  const db = idbHarness(), resetTab = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: webcrypto });
  await resetTab.create(context());
  const delay = delayedCrypto('generateKey'), newTab = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: delay.crypto });
  const pending = newTab.create(context({ key_generation: 2 }));
  await delay.entered.promise;
  await resetTab.clearOlderGenerations(context(), 2);
  delay.release.resolve(); await pending;
  assert.deepEqual(db.records().map(record => record.key_generation), [2]);
});

test('timeouts fail closed for stuck opens and transactions', async () => {
  const noOpen = createTrustedKeyStore({ indexedDB: { open: () => ({}) }, crypto: webcrypto, timeoutMs: 5 });
  await assert.rejects(noOpen.read(context()), code('trustedBrowserStorageUnavailable'));
  const { store, engine, records } = harness({ timeoutMs: 5 });
  const release = defer(); engine.beforeCommit = () => release.promise;
  await assert.rejects(store.create(context()), code('trustedBrowserStorageUnavailable'));
  release.resolve();
  assert.equal(records().length, 0);
});

test('key lease rejects cross-tab forget during caller unwrap/derivation', async () => {
  const db = idbHarness(), reader = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: webcrypto });
  const other = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: webcrypto });
  await reader.create(context());
  const lease = await reader.readLease(context());
  assert.ok(lease?.key); await lease.assertCurrent();
  await other.remove(context());
  await assert.rejects(lease.assertCurrent(), abortError);
  assert.equal(await reader.readLease(context()), null);
});

test('key lease checks the exact durable record revision as well as logout epochs', async () => {
  const db = idbHarness(), reader = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: webcrypto });
  const other = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: webcrypto });
  await reader.create(context());
  const lease = await reader.readLease(context());
  await other.markActive(context(), 'credential_A');
  await assert.rejects(lease.assertCurrent(), abortError);
  const current = await reader.readLease(context());
  await current.assertCurrent();
  await other.clearAccount('account-a');
  await assert.rejects(current.assertCurrent(), abortError);
});

test('read lease binds the expected public credential context', async () => {
  const { store } = harness(); await store.create({ ...context(), credential_id: 'credential_A' });
  await assert.rejects(store.readLease({ ...context(), credential_id: 'credential_B' }), code('trustedBrowserKeyInvalid'));
  const lease = await store.readLease({ ...context(), credential_id: 'credential_A' });
  assert.ok(lease); await lease.assertCurrent();
});

test('failure to clean a failed enrollment remains visible to the caller', async () => {
  const { store, engine, records } = harness();
  const different = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  engine.transformRead = record => {
    if (record) engine.failWrites = true;
    return record && { ...record, key: different };
  };
  await assert.rejects(store.create(context()), error => error?.code === 'trustedCleanupFailed'
    && error.cleanupCause?.code === 'trustedBrowserStorageUnavailable');
  assert.equal(records().length, 1);
  engine.failWrites = false; engine.transformRead = null;
  await store.clearAccount('account-a');
  assert.equal(records().length, 0);
});

test('markActive is idempotent and preserves an existing active key lease', async () => {
  const { store } = harness(); await store.create(context()); await store.markActive(context(), 'credential_A');
  const lease = await store.readLease(context()); const [before] = await store.list(context());
  await store.markActive(context(), 'credential_A'); const [after] = await store.list(context());
  assert.equal(after.revision, before.revision); await lease.assertCurrent();
});

test('account-wide reset cleans every RP and fences an unknown-RP pending create across tabs', async () => {
  const db = idbHarness(), resetTab = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: webcrypto });
  await resetTab.create(context());
  await resetTab.create(context({ rp_id: 'another.example.test' }));
  await resetTab.create(context({ account_id: 'account-b' }));
  await resetTab.create(context({ key_generation: 2 }));
  const delay = delayedCrypto('generateKey'), unknownTab = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: delay.crypto });
  const unknownContext = context({ rp_id: 'never-seen.example.test' });
  const pending = unknownTab.create(unknownContext); const rejected = assert.rejects(pending, abortError);
  await delay.entered.promise;
  await resetTab.clearAccountOlderGenerations('account-a', 2);
  delay.release.resolve(); await rejected;
  assert.deepEqual(db.records().map(record => [record.account_id, record.key_generation]), [['account-b', 1], ['account-a', 2]]);
  const freshTab = createTrustedKeyStore({ indexedDB: db.newFactory(), crypto: webcrypto });
  await assert.rejects(freshTab.create(unknownContext), abortError);
  await freshTab.create({ ...unknownContext, key_generation: 2 });
  await resetTab.clearAccountOlderGenerations('account-a', 1);
  await assert.rejects(freshTab.create(context({ rp_id: 'fourth.example.test' })), abortError);
});

test('listAll exposes only revision-bound public contexts for a pre-authenticated-list snapshot', async () => {
  const { store } = harness();
  const first = context(), second = context({ account_id: 'account-b', rp_id: 'second.example.test' });
  await store.create({ ...first, credential_id: 'credential_A', token: 'NEVER-PERSIST', urk: 'NEVER-PERSIST' });
  await store.markActive(first, 'credential_A');
  await store.create(second);
  const snapshot = await store.listAll();
  assert.equal(snapshot.length, 2);
  assert.deepEqual(snapshot.map(record => record.account_id), ['account-a', 'account-b']);
  assert.deepEqual(Object.keys(snapshot[0]).sort(), ['account_id', 'active', 'credential_id', 'device_id', 'key_generation', 'revision', 'rp_id']);
  assert.deepEqual(Object.keys(snapshot[1]).sort(), ['account_id', 'active', 'device_id', 'key_generation', 'revision', 'rp_id']);
  assert.ok(snapshot.every(record => /^[0-9a-f]{32}$/.test(record.revision) && !('key' in record)));
  assert.equal(JSON.stringify(snapshot).includes('NEVER-PERSIST'), false);
  await store.reconcile(first, [], { observedRecords: snapshot.filter(record => record.account_id === first.account_id && record.rp_id === first.rp_id) });
  assert.equal(await store.read(first), null);
  assert.ok(await store.read(second));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(store.listAll({ signal: controller.signal }), abortError);
  await assert.rejects(store.listAll({ isCurrent: () => false }), abortError);
});
