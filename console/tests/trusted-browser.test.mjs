import test from 'node:test';
import { pbkdf2Sync } from 'node:crypto';
import assert from 'node:assert/strict';
import { bindTrustedBrowser, unlockWithTrustedBrowser, wrapTrustedUrk, unwrapTrustedUrk, rememberTrustedAccount, moveTrustedAccount, forgetTrustedAccount } from '../src/trustedBrowser.js';
import { encodeBase64url as b64, passkeyCommitConfirmed } from '../src/passkeys.js';
import { wrapVaultV4, wrapVault, toHex, deriveDataKeys, encryptItem, decryptItem, unwrapUrk } from '../src/crypto.js';

const bytes = (n, x) => new Uint8Array(n).fill(x);
const URK = bytes(32, 55), RECOVERY = 'A3-000102-030405-060708-090a0b-0c0d0e-0f1011';
const META = { mode: 'trusted_browser', account_id: 'fixture-account-id', rp_id: 'localhost', key_generation: 2,
  credential_id: b64(bytes(24, 9)), device_id: '11223344-1122-4122-8122-112233445566' };
const CONFIG = { enabled: true, trusted_browser_enabled: true, ...META };
const vault = async () => ({ ...await wrapVaultV4(RECOVERY, URK), account_id: META.account_id, key_generation: META.key_generation });
const generate = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
function nativeCredential(registration = false) {
  return { type: 'public-key', id: META.credential_id, rawId: bytes(24, 9),
    response: { clientDataJSON: bytes(20, 1), ...(registration ? { attestationObject: bytes(40, 2) }
      : { authenticatorData: bytes(37, 3), signature: bytes(64, 4), userHandle: null }) },
    getClientExtensionResults: () => ({}), toJSON: () => assert.fail('Unsafe serialization') };
}
function harness(hooks = {}) {
  const requests = [], events = [], keys = new Map();
  let gets = 0, wrapper;
  const id = c => JSON.stringify([c.account_id, c.rp_id, c.device_id, c.key_generation]);
  const keyStore = {
    async create(c) { events.push('persist'); if (hooks.create) return hooks.create(c); const key = await generate(); keys.set(id(c), { key: structuredClone(key) }); return this.read(c); },
    async read(c) { events.push('readback'); if (hooks.read) await hooks.read(c); return keys.get(id(c))?.key || null; },
    async readLease(c) { const record = keys.get(id(c)); if (!record) return null; return { key: record.key, assertCurrent: async () => {
      if (hooks.beforeAccept && wrapper) await hooks.beforeAccept();
      if (keys.get(id(c)) !== record) throw new DOMException('Local key revoked', 'AbortError');
    } }; },
    async markActive(c) { events.push('active'); assert.ok(keys.has(id(c))); },
    async remove(c) { events.push('remove'); keys.delete(id(c)); },
    clear() { keys.clear(); },
  };
  const envelope = (phase, registration = false) => ({ ...META, ceremony_id: phase,
    public_key: registration ? { challenge: b64(bytes(32, 1)), rp: { id: META.rp_id, name: 'Synthetic' },
      user: { id: b64(bytes(16, 2)), name: 'Synthetic', displayName: 'Synthetic' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] }
      : { challenge: b64(bytes(32, phase === 'test' ? 3 : 4)), rpId: META.rp_id, allowCredentials: [{ type: 'public-key', id: META.credential_id }] } });
  const request = async (path, options) => {
    requests.push({ path, body: structuredClone(options.body) });
    assert.equal(options.body.mode, META.mode); assert.equal(options.body.device_id, META.device_id);
    const sent = JSON.stringify(options.body);
    for (const secret of [RECOVERY, b64(URK), '"results"', '"key"']) assert.equal(sent.includes(secret), false);
    if (hooks.request) await hooks.request(path, options);
    if (path === '/register/start') return envelope('create', true);
    if (path === '/register/finish') return { ...envelope('test'), ...hooks.contextPatch };
    if (path === '/register/test') return envelope('commit');
    if (path === '/register/commit') { wrapper = options.body.wrapper; return { ok: true }; }
    if (path === '/unlock/start') return envelope('unlock');
    if (path === '/unlock/finish') return { ...META, wrapper, ...hooks.unlockPatch };
    assert.fail(path);
  };
  const credentials = {
    create: async options => { events.push('create'); assert.deepEqual(options.publicKey.extensions, {});
      assert.equal(options.publicKey.authenticatorSelection.userVerification, 'required'); return nativeCredential(true); },
    get: async options => { gets++; events.push(`get${gets}`); assert.deepEqual(options.publicKey.extensions, {});
      assert.equal(options.publicKey.userVerification, 'required'); if (hooks.get) await hooks.get(gets, options); return nativeCredential(); },
  };
  return { request, credentials, keyStore, keys, requests, events, get gets() { return gets; }, get wrapper() { return wrapper; } };
}
const bind = async (h, rest = {}) => bindTrustedBrowser({ ...h, config: CONFIG, vault: await vault(), superPass: RECOVERY,
  label: 'Synthetic trusted browser', deviceId: META.device_id, ...rest });
const unlock = async (h, rest = {}) => unlockWithTrustedBrowser({ ...h, config: CONFIG, vault: await vault(),
  credentialId: META.credential_id, deviceId: META.device_id, ...rest });

test('ordinary empty-extension credentials bind only after persistence/readback and two fresh UV assertions', async () => {
  const h = harness(), v = await vault(), original = JSON.stringify(v);
  assert.deepEqual(await bind(h, { vault: v }), META);
  assert.equal(h.gets, 2);
  assert.ok(h.events.indexOf('persist') < h.events.indexOf('get1'));
  assert.ok(h.events.indexOf('readback') < h.events.indexOf('get1'));
  assert.deepEqual(h.requests.map(r => r.path), ['/register/start', '/register/finish', '/register/test', '/register/commit']);
  assert.equal(JSON.stringify(v), original);
  assert.deepEqual(await unwrapUrk(RECOVERY, undefined, v), URK);
  const expected = await deriveDataKeys(URK, true), memory = await encryptItem(expected, 'pre-existing synthetic memory');
  const keys = await unlock(h);
  assert.deepEqual(keys, expected);
  assert.equal(await decryptItem(keys, memory.ciphertext, memory.nonce), 'pre-existing synthetic memory');
  assert.equal(h.gets, 3);
  assert.equal(h.wrapper.kdf, 'trusted-browser-aes256gcm-v1');
});

test('trusted wrapper authenticates mode/account/RP/device/credential/generation and rejects tampering', async () => {
  const key = await generate(), wrapped = await wrapTrustedUrk(URK, key, META);
  for (const patch of [{ mode: 'prf' }, { account_id: 'other' }, { rp_id: 'other.test' },
    { device_id: '11223344-1122-4122-8122-112233445567' }, { credential_id: b64(bytes(24, 8)) }, { key_generation: 3 }]) {
    await assert.rejects(unwrapTrustedUrk(wrapped, key, { ...META, ...patch }));
  }
  await assert.rejects(unwrapTrustedUrk(wrapped, await generate(), META));
  await assert.rejects(unwrapTrustedUrk({ ...wrapped, kdf: 'webauthn-prf-hkdf-sha256-v1' }, key, META));
  await assert.rejects(unwrapTrustedUrk({ ...wrapped, nonce: b64(bytes(12, 0)) }, key, META));
  await assert.rejects(unwrapTrustedUrk({ ...wrapped, wrapped_urk: b64(bytes(48, 0)) }, key, META));
  const exportable = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  await assert.rejects(wrapTrustedUrk(URK, exportable, META), { code: 'trustedKeyMissing' });
});

test('storage creation failure, readback loss, cancellation and stale flow never activate a binding', async t => {
  for (const failure of ['create', 'readback', 'cancel', 'stale']) await t.test(failure, async () => {
    let current = true;
    const h = harness({
      ...(failure === 'create' ? { create: () => { throw new Error('Synthetic IDB denied'); } } : {}),
      get: async count => {
        if (failure === 'cancel') throw new DOMException('Cancelled', 'NotAllowedError');
        if (failure === 'stale') current = false;
        if (failure === 'readback' && count === 2) h.keyStore.clear();
      },
    });
    await assert.rejects(bind(h, { isCurrent: () => current }));
    assert.equal(h.requests.some(r => r.path === '/register/commit'), false);
    assert.equal(h.keys.size, 0);
  });
});

test('trusted mode must be explicitly enabled and context cannot change during enrollment', async () => {
  const h = harness();
  await assert.rejects(bind(h, { config: { ...CONFIG, trusted_browser_enabled: false } }), { code: 'trustedBrowserDisabled' });
  assert.equal(h.requests.length, 0);
  for (const contextPatch of [{ account_id: 'other' }, { device_id: crypto.randomUUID() }, { mode: 'prf' }, { key_generation: 3 }]) {
    const broken = harness({ contextPatch }); await assert.rejects(bind(broken), { code: 'passkeyChanged' });
    assert.equal(broken.keys.size, 0); assert.equal(broken.gets, 0);
  }
});

test('ambiguous commit keeps only the local key for safe reconciliation, with no retry or removal', async () => {
  const h = harness({ request: path => { if (path === '/register/commit') throw new TypeError('Response lost'); } });
  await assert.rejects(bind(h), { code: 'passkeyCommitUnknown' });
  assert.equal(h.keys.size, 1);
  assert.equal(h.requests.filter(r => r.path === '/register/commit').length, 1);
  assert.equal(h.events.includes('remove'), false);
  const config = { ...CONFIG, credentials: [META] };
  assert.equal(passkeyCommitConfirmed(META, config), true);
  for (const patch of [{ mode: 'prf' }, { device_id: crypto.randomUUID() }]) {
    assert.equal(passkeyCommitConfirmed(META, { ...config, credentials: [{ ...META, ...patch }] }), false);
  }
});

test('unlock after site-data loss fails before native prompt or API wrapper release', async () => {
  const h = harness(); await bind(h); h.keyStore.clear();
  const before = h.requests.length;
  await assert.rejects(unlock(h), { code: 'trustedKeyMissing' });
  assert.equal(h.gets, 2); assert.equal(h.requests.length, before);
});

test('server-response context changes and key removal during final crypto fencing cannot unlock', async () => {
  for (const unlockPatch of [{ device_id: crypto.randomUUID() }, { mode: 'prf' }, { account_id: 'other' }]) {
    const h = harness({ unlockPatch }); await bind(h); await assert.rejects(unlock(h), { code: 'passkeyChanged' });
  }
  const h = harness({ beforeAccept: () => h.keyStore.clear() });
  await bind(h); await assert.rejects(unlock(h), { name: 'AbortError' });
});

test('same-account token rotation does not change durable encryption identity', async () => {
  const h = harness(); await bind(h);
  const keys = [...h.keys.keys()];
  let lease;
  await unlock(h, { onKeyLease: value => { lease = value; } });
  assert.deepEqual([...h.keys.keys()], keys);
  assert.equal(keys.some(key => /token/i.test(key)), false);
  await lease.assertCurrent();
  h.keyStore.clear(); await assert.rejects(lease.assertCurrent(), { name: 'AbortError' });
});


test('logout targets only a verified account, unknown identity falls back to all, and failed rotation does not transfer', async () => {
  const cleared = [];
  const store = { clearAccount: async account => cleared.push(account), clearAll: async () => cleared.push('ALL') };
  rememberTrustedAccount('account-a-token', 'account-a');
  rememberTrustedAccount('account-b-token', 'account-b');
  moveTrustedAccount('account-a-token', 'unsaved-token', 'account-a-token');
  let forgotten = forgetTrustedAccount('account-a-token', store);
  assert.equal(forgotten.allAccounts, false); await forgotten.completion;
  assert.deepEqual(cleared, ['account-a']);
  forgotten = forgetTrustedAccount('account-b-token', store);
  assert.equal(forgotten.allAccounts, false); await forgotten.completion;
  assert.deepEqual(cleared, ['account-a', 'account-b']);
  forgotten = forgetTrustedAccount('unknown-identity', store);
  assert.equal(forgotten.allAccounts, true); await forgotten.completion;
  assert.deepEqual(cleared, ['account-a', 'account-b', 'ALL']);
  rememberTrustedAccount('before-rotation', 'stable-account');
  moveTrustedAccount('before-rotation', 'after-rotation', 'after-rotation');
  await forgetTrustedAccount('after-rotation', store).completion;
  assert.equal(cleared.at(-1), 'stable-account');
});

test('passive logout never deletes durable keys, even for known identities after reenrollment', async () => {
  const cleared = [];
  const store = {
    clearAccount: async account => { cleared.push(account); return { clearedRecords: 1 }; },
    clearAll: async () => { cleared.push('ALL'); return { clearedRecords: 2 }; },
  };
  const passive = forgetTrustedAccount('unknown-passive-token', store, { passive: true });
  assert.equal(passive.allAccounts, false);
  assert.deepEqual(await passive.completion, { clearedRecords: 0 });
  assert.deepEqual(cleared, []);
  rememberTrustedAccount('known-passive-token', 'account-a');
  const newEnrollment = { account_id: 'account-a', device_id: 'new-device' };
  store.clearAccount = async account => { cleared.push(account); newEnrollment.deleted = true; return { clearedRecords: 1 }; };
  const known = forgetTrustedAccount('known-passive-token', store, { passive: true });
  assert.equal(known.allAccounts, false);
  assert.deepEqual(await known.completion, { clearedRecords: 0 });
  assert.deepEqual(cleared, []);
  assert.equal(newEnrollment.deleted, undefined);
  const initiating = forgetTrustedAccount('unknown-initiating-token', store);
  assert.equal(initiating.allAccounts, true);
  assert.deepEqual(await initiating.completion, { clearedRecords: 2 });
  assert.deepEqual(cleared, ['ALL']);
});


test('trusted binding preserves legacy recovery wrappers v1 through v3 and their existing URK', async t => {
  for (const version of [1, 2, 3]) await t.test(`v${version}`, async () => {
    const superPass = 'Synthetic legacy recovery', secretKey = version === 3 ? 'Synthetic legacy secret' : undefined;
    let v;
    if (version === 3) v = await wrapVault(superPass, secretKey, URK);
    else {
      const salt = bytes(16, 7), nonce = bytes(12, 8);
      const key = await crypto.subtle.importKey('raw', pbkdf2Sync(superPass, salt, 210000, 32, 'sha256'), 'AES-GCM', false, ['encrypt']);
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, URK));
      v = { version, kdf_salt: toHex(salt), urk_nonce: toHex(nonce), wrapped_urk: toHex(encrypted) };
    }
    v = { ...v, account_id: META.account_id, key_generation: META.key_generation };
    const original = structuredClone(v), h = harness();
    await bind(h, { vault: v, superPass, secretKey });
    assert.deepEqual(v, original); assert.deepEqual(await unwrapUrk(superPass, secretKey, v), URK);
    const keys = await unlock(h, { vault: v });
    assert.deepEqual(keys, await deriveDataKeys(URK, v.wrapped_urk.startsWith('rsrs:v1:')));
    const sent = JSON.stringify(h.requests);
    assert.equal(sent.includes(superPass), false); if (secretKey) assert.equal(sent.includes(secretKey), false);
  });
});
