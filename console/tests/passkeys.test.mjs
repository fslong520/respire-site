import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pbkdf2Sync } from 'node:crypto';
import {
  bindPasskey, unlockWithPasskey, wrapPasskeyUrk, unwrapPasskeyUrk,
  serializePasskeyCredential, encodeBase64url as b64, decodeBase64url,
  validatePasskeyContext, validatePasskeyOrigin, creationOptions, assertionOptions, passkeyCommitConfirmed, passkeyCommitContextChanged, reconcilePasskeyCommit, movePasskeyCommit,
} from '../src/passkeys.js';
import { wrapVault, wrapVaultV4, unwrapUrk, deriveDataKeys, encryptItem, decryptItem, toHex } from '../src/crypto.js';

const bytes = (size, value) => new Uint8Array(size).fill(value);
const PRF = bytes(32, 75);
const URK = bytes(32, 122);
const RECOVERY = 'A3-000102-030405-060708-090a0b-0c0d0e-0f1011';
const CONTEXT = { account_id: 'account-immutable-id', rp_id: 'dashboard.example.test', credential_id: b64(bytes(24, 9)), key_generation: 7, prf_salt: b64(bytes(32, 11)) };
const CONFIG = { enabled: true, origin: 'https://dashboard.example.test', ...CONTEXT, credentials: [{ ...CONTEXT, label: 'Synthetic passkey' }] };
const vaultV4 = async () => ({ ...await wrapVaultV4(RECOVERY, URK), account_id: CONTEXT.account_id, key_generation: CONTEXT.key_generation });
function credential({ registration = false, enabled = true, prf = PRF, id = CONTEXT.credential_id } = {}) {
  const result = prf === null ? undefined : prf.slice();
  const extensions = { prf: { ...(registration ? { enabled } : {}), ...(result ? { results: { first: result.buffer } } : {}) }, unexpected: 'must not serialize' };
  return { id, rawId: decodeBase64url(id), type: 'public-key', extraSecret: 'must not serialize',
    response: { clientDataJSON: bytes(12, 1), ...(registration ? { attestationObject: bytes(32, 2), getTransports: () => ['internal', 'secret-transport'] }
      : { authenticatorData: bytes(37, 3), signature: bytes(64, 4), userHandle: bytes(16, 5) }), extraSecret: 'must not serialize' },
    getClientExtensionResults: () => extensions,
    toJSON: () => { throw new Error('Never serialize credentials with toJSON'); }, result };
}
const creation = { ...CONTEXT, ceremony_id: 'register', public_key: { challenge: b64(bytes(32, 1)), rp: { id: CONTEXT.rp_id, name: 'Respire' },
  user: { id: b64(bytes(32, 4)), name: 'synthetic', displayName: 'Synthetic' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] } };
const assertion = stage => ({ ...CONTEXT, ceremony_id: stage, public_key: { challenge: b64(bytes(32, stage === 'test' ? 2 : 3)), rpId: CONTEXT.rp_id,
  allowCredentials: [{ type: 'public-key', id: CONTEXT.credential_id }], userVerification: 'required' } });
function harness(overrides = {}) {
  const sent = [], issued = [];
  let gets = 0, committed;
  const credentials = {
    create: async options => {
      assert.deepEqual(options.publicKey.extensions, { prf: {} });
      assert.equal(options.publicKey.authenticatorSelection.userVerification, 'required');
      if (overrides.onCreate) return overrides.onCreate(options);
      const c = credential({ registration: true, prf: null }); issued.push(c); return c;
    },
    get: async options => {
      gets++;
      assert.deepEqual(options.publicKey.extensions.prf.eval.first, decodeBase64url(CONTEXT.prf_salt));
      assert.equal(options.publicKey.userVerification, 'required');
      if (overrides.onGet) return overrides.onGet(gets, options);
      const c = credential(); issued.push(c); return c;
    },
  };
  const request = async (path, options) => {
    sent.push({ path, body: structuredClone(options.body) });
    const serialized = JSON.stringify(options.body);
    assert.ok(!serialized.includes('must not serialize'));
    assert.ok(!serialized.includes('results'));
    assert.ok(!serialized.includes(b64(PRF)));
    assert.ok(!serialized.includes(b64(URK)));
    assert.ok(!serialized.includes(RECOVERY));
    if (overrides.onRequest) await overrides.onRequest(path, options);
    if (path === '/register/start') return structuredClone(creation);
    if (path === '/register/finish') return assertion('test');
    if (path === '/register/test') return assertion('commit');
    if (path === '/register/commit') { committed = options.body.wrapper; return { ok: true }; }
    if (path === '/unlock/start') return assertion('unlock');
    if (path === '/unlock/finish') return { ...CONTEXT, wrapper: overrides.wrapper || committed };
    throw new Error(`Unexpected path ${path}`);
  };
  return { credentials, request, sent, issued, get committed() { return committed; } };
}
const bind = async (h, rest = {}) => bindPasskey({ request: h.request, credentials: h.credentials, vault: await vaultV4(), config: CONFIG,
  superPass: RECOVERY, label: 'Synthetic passkey', isCurrent: () => true, ...rest });

test('PRF wrapper decrypts exact existing URK and preserves current and legacy ciphertext', async () => {
  const wrapped = await wrapPasskeyUrk(URK, PRF, CONTEXT);
  assert.deepEqual(Object.keys(wrapped).sort(), ['kdf', 'nonce', 'version', 'wrapped_urk']);
  assert.equal(decodeBase64url(wrapped.wrapped_urk).length, 48);
  assert.equal(decodeBase64url(wrapped.nonce).length, 12);
  assert.deepEqual(await unwrapPasskeyUrk(wrapped, PRF, CONTEXT), URK);
  const before = await deriveDataKeys(URK, true);
  const after = await deriveDataKeys(await unwrapPasskeyUrk(wrapped, PRF, CONTEXT), true);
  assert.deepEqual(after, before);
  for (const writeCurrent of [false, true]) {
    const encrypted = await encryptItem({ ...before, writeCurrent }, 'Already encrypted memory');
    assert.equal(await decryptItem(after, encrypted.ciphertext, encrypted.nonce), 'Already encrypted memory');
  }
});

test('AES-GCM authenticates account, RP, credential, generation, salt, ciphertext, and nonce', async t => {
  const wrapped = await wrapPasskeyUrk(URK, PRF, CONTEXT);
  const variants = {
    account: { ...CONTEXT, account_id: 'different-account' }, rp: { ...CONTEXT, rp_id: 'evil.example.test' },
    credential: { ...CONTEXT, credential_id: b64(bytes(24, 10)) }, generation: { ...CONTEXT, key_generation: 8 },
    salt: { ...CONTEXT, prf_salt: b64(bytes(32, 12)) },
  };
  for (const [name, context] of Object.entries(variants)) await t.test(name, () => assert.rejects(unwrapPasskeyUrk(wrapped, PRF, context)));
  await assert.rejects(unwrapPasskeyUrk(wrapped, bytes(32, 76), CONTEXT));
  for (const field of ['wrapped_urk', 'nonce']) {
    const changed = decodeBase64url(wrapped[field]); changed[0] ^= 1;
    await assert.rejects(unwrapPasskeyUrk({ ...wrapped, [field]: b64(changed) }, PRF, CONTEXT));
  }
  await assert.rejects(unwrapPasskeyUrk({ ...wrapped, version: 2 }, PRF, CONTEXT));
  await assert.rejects(unwrapPasskeyUrk({ ...wrapped, wrapped_urk: b64(bytes(47, 1)) }, PRF, CONTEXT));
  assert.throws(() => decodeBase64url('AA=='));
});

test('strict credential allowlist excludes all PRF outputs and does not use toJSON', () => {
  for (const registration of [true, false]) {
    const input = credential({ registration });
    const output = serializePasskeyCredential(input, registration, true);
    assert.deepEqual(output.clientExtensionResults, { prf: { enabled: true } });
    assert.equal(JSON.stringify(output).includes('results'), false);
    assert.equal(JSON.stringify(output).includes('must not serialize'), false);
    assert.equal(JSON.stringify(output).includes(b64(PRF)), false);
    if (registration) assert.deepEqual(output.response.transports, ['internal']);
    else assert.equal(output.response.userHandle, b64(bytes(16, 5)));
  }
  assert.throws(() => serializePasskeyCredential({ ...credential(), id: b64(bytes(16, 99)) }));
});

test('binding requires create then TWO separately challenged gets before committing same-URK wrapper', async () => {
  const h = harness();
  const vault = await vaultV4();
  const unchanged = structuredClone(vault);
  await bind(h, { vault });
  assert.deepEqual(vault, unchanged);
  assert.deepEqual(h.sent.map(x => x.path), ['/register/start', '/register/finish', '/register/test', '/register/commit']);
  assert.equal(h.sent.at(-1).body.ceremony_id, 'commit');
  assert.deepEqual(await unwrapPasskeyUrk(h.committed, PRF, CONTEXT), URK);
  assert.deepEqual(await unwrapUrk(RECOVERY, undefined, vault), URK);
  assert.ok(h.issued.filter(x => x.result).every(x => x.result.every(byte => byte === 0)), 'PRF buffers wiped');
  const keys = await unlockWithPasskey({ request: h.request, credentials: h.credentials, vault, config: CONFIG, credentialId: CONTEXT.credential_id });
  assert.deepEqual(keys, await deriveDataKeys(URK, true));
  assert.deepEqual(h.sent.slice(-2).map(x => x.path), ['/unlock/start', '/unlock/finish']);
});

test('missing PRF enabled/result, wrong-sized PRF, and unstable provider output fail closed', async t => {
  const cases = {
    unsupported: { onCreate: () => credential({ registration: true, enabled: false, prf: null }), code: 'passkeyPrfCreateUnavailable' },
    emptyExtensions: { onCreate: () => ({ ...credential({ registration: true, prf: null }), getClientExtensionResults: () => ({}) }),
      onGet: () => { assert.fail('Unsupported registration must never request verification'); }, code: 'passkeyPrfCreateUnavailable' },
    missingFirst: { onGet: () => credential({ prf: null }), code: 'passkeyPrfFirstMissing' },
    missingSecond: { onGet: count => credential({ prf: count === 2 ? null : PRF }), code: 'passkeyPrfReopenMissing' },
    wrongSize: { onGet: () => credential({ prf: bytes(31, 1) }), code: 'passkeyPrfFirstMissing' },
    unstable: { onGet: count => credential({ prf: count === 2 ? bytes(32, 99) : PRF }) },
  };
  for (const [name, overrides] of Object.entries(cases)) await t.test(name, async () => {
    const h = harness(overrides), vault = await vaultV4();
    await assert.rejects(bind(h, { vault }), overrides.code ? { code: overrides.code } : { name: 'OperationError' });
    if (overrides.onCreate) assert.deepEqual(h.sent.map(x => x.path), ['/register/start']);
    if (name === 'missingFirst' || name === 'wrongSize') assert.deepEqual(h.sent.map(x => x.path), ['/register/start', '/register/finish']);
    if (name === 'missingSecond') assert.deepEqual(h.sent.map(x => x.path), ['/register/start', '/register/finish', '/register/test']);
    assert.equal(h.sent.some(x => x.path === '/register/commit'), false);
    assert.deepEqual(await unwrapUrk(RECOVERY, undefined, vault), URK);
  });
});

test('cancellation at create, first get, or reopening never commits; retry is independent', async t => {
  for (const stop of ['create', 1, 2]) await t.test(String(stop), async () => {
    const h = harness({ onCreate: () => {
      if (stop === 'create') throw new DOMException('Cancelled', 'NotAllowedError');
      return credential({ registration: true, prf: null });
    }, onGet: count => {
      if (stop === count) throw new DOMException('Cancelled', 'NotAllowedError');
      return credential();
    } });
    await assert.rejects(bind(h), { name: 'NotAllowedError' });
    assert.equal(h.committed, undefined);
    const retry = harness(); await bind(retry); assert.ok(retry.committed);
  });
});

test('abort signal and account/unlock generation fences reject late successful browser results', async t => {
  for (const staleAt of ['create', 'firstGet', 'secondGet', 'beforeCommit']) await t.test(staleAt, async () => {
    let current = true;
    const controller = new AbortController();
    const h = harness({ onCreate: () => {
      if (staleAt === 'create') current = false;
      return credential({ registration: true, prf: null });
    }, onGet: count => {
      if (staleAt === 'firstGet' && count === 1) controller.abort();
      if (staleAt === 'secondGet' && count === 2) current = false;
      return credential();
    }, onRequest: path => { if (staleAt === 'beforeCommit' && path === '/register/test') current = false; } });
    await assert.rejects(bind(h, { isCurrent: () => current, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(h.committed, undefined);
  });
});

test('unlock missing PRF or stale generation cannot obtain or activate keys', async () => {
  const vault = await vaultV4();
  const wrapper = await wrapPasskeyUrk(URK, PRF, CONTEXT);
  const noPrf = harness({ wrapper, onGet: () => credential({ prf: null }) });
  await assert.rejects(unlockWithPasskey({ ...noPrf, vault, config: CONFIG, credentialId: CONTEXT.credential_id }), { code: 'passkeyPrfUnlockMissing' });
  assert.equal(noPrf.sent.some(x => x.path === '/unlock/finish'), false);
  let current = true;
  const stale = harness({ wrapper, onRequest: path => { if (path === '/unlock/finish') current = false; } });
  await assert.rejects(unlockWithPasskey({ ...stale, vault, config: CONFIG, credentialId: CONTEXT.credential_id, isCurrent: () => current }), { name: 'AbortError' });
});

test('account, generation, RP origin and selected credential must match current authenticated context', async () => {
  const vault = await vaultV4();
  for (const patch of [{ account_id: 'another' }, { key_generation: 8 }, { rp_id: 'other.test' }, { credential_id: b64(bytes(24, 88)) }]) {
    assert.throws(() => validatePasskeyContext({ ...CONTEXT, ...patch }, vault, CONFIG, CONTEXT.credential_id));
  }
  validatePasskeyOrigin(CONFIG, { origin: CONFIG.origin, hostname: CONTEXT.rp_id });
  assert.throws(() => validatePasskeyOrigin(CONFIG, { origin: 'https://evil.test', hostname: 'evil.test' }));
  assert.throws(() => assertionOptions({ ...assertion('test'), public_key: { ...assertion('test').public_key, allowCredentials: [] } }));
  assert.throws(() => creationOptions({ ...creation, rp_id: 'other.test' }));
});

test('existing v1/v2 PBKDF2, v3 super+secret, v4 A3 recovery wrappers remain compatible during binding', async t => {
  for (const version of [1, 2, 3, 4]) await t.test(`v${version}`, async () => {
    const superPass = version === 4 ? RECOVERY : 'Synthetic old super password';
    const secretKey = version === 3 ? 'Synthetic secret key' : undefined;
    let vault;
    if (version === 4) vault = await wrapVaultV4(superPass, URK);
    else if (version === 3) vault = await wrapVault(superPass, secretKey, URK);
    else {
      const salt = bytes(16, 9), nonce = bytes(12, 8);
      const keyBytes = pbkdf2Sync(superPass, salt, 210000, 32, 'sha256');
      const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, URK));
      vault = { version, kdf_salt: toHex(salt), urk_nonce: toHex(nonce), wrapped_urk: toHex(encrypted) };
    }
    vault = { ...vault, account_id: CONTEXT.account_id, key_generation: CONTEXT.key_generation };
    const original = structuredClone(vault), h = harness();
    await bind(h, { vault, superPass, secretKey });
    assert.deepEqual(vault, original);
    assert.deepEqual(await unwrapUrk(superPass, secretKey, vault), URK);
    assert.deepEqual(await unwrapPasskeyUrk(h.committed, PRF, CONTEXT), URK);
  });
});


test('commit dispatch failure is outcome-unknown, never retried or automatically removed', async () => {
  let serverAccepted = false;
  const stages = [];
  const h = harness({ onRequest: path => {
    if (path === '/register/commit') { serverAccepted = true; throw new TypeError('Synthetic lost confirmation'); }
  } });
  await assert.rejects(bind(h, { onStage: (stage, metadata) => stages.push({ stage, metadata }) }), { code: 'passkeyCommitUnknown' });
  assert.equal(serverAccepted, true);
  assert.equal(h.sent.filter(x => x.path === '/register/commit').length, 1);
  assert.equal(h.sent.some(x => x.path === '/remove'), false);
  assert.deepEqual(stages.at(-1), { stage: 'passkeyCommitting', metadata: {
    account_id: CONTEXT.account_id, rp_id: CONTEXT.rp_id, credential_id: CONTEXT.credential_id, key_generation: CONTEXT.key_generation,
  } });
  assert.ok(h.issued.filter(x => x.result).every(x => x.result.every(byte => byte === 0)));
});

test('cancelled or superseded successful commit response remains outcome-unknown', async t => {
  for (const change of ['abort', 'account changed']) await t.test(change, async () => {
    const controller = new AbortController();
    let current = true;
    const h = harness({ onRequest: path => {
      if (path === '/register/commit') {
        if (change === 'abort') controller.abort(); else current = false;
      }
    } });
    await assert.rejects(bind(h, { signal: controller.signal, isCurrent: () => current }), { code: 'passkeyCommitUnknown' });
    assert.ok(h.committed, 'The synthetic server committed despite the client cancellation');
    assert.equal(h.sent.filter(x => x.path === '/register/commit').length, 1);
    assert.equal(h.sent.some(x => x.path === '/remove'), false);
  });
});

test('only a positive same-account/generation authoritative list resolves uncertain commit', () => {
  assert.equal(passkeyCommitConfirmed(CONTEXT, CONFIG), true);
  assert.equal(passkeyCommitConfirmed(CONTEXT, { ...CONFIG, credentials: [] }), false, 'Early empty list is still unknown');
  assert.equal(passkeyCommitConfirmed(CONTEXT, undefined), false, 'Failed list read is still unknown');
  for (const patch of [{ account_id: 'other-account' }, { rp_id: 'other.test' }, { key_generation: 8 }, { enabled: false },
    { credentials: [{ ...CONTEXT, credential_id: b64(bytes(24, 19)) }] }, { credentials: [{ ...CONTEXT, key_generation: 8 }] }]) {
    assert.equal(passkeyCommitConfirmed(CONTEXT, { ...CONFIG, ...patch }), false);
  }
});


test('authoritative context change clears the local retry fence without claiming historic non-binding', () => {
  assert.equal(passkeyCommitContextChanged(CONTEXT, CONFIG), false);
  assert.equal(passkeyCommitContextChanged(CONTEXT, { ...CONFIG, credentials: [] }), false);
  assert.equal(passkeyCommitContextChanged(CONTEXT, undefined), false);
  assert.equal(passkeyCommitContextChanged(CONTEXT, { ...CONFIG, key_generation: 8 }), true);
  assert.equal(passkeyCommitContextChanged(CONTEXT, { ...CONFIG, account_id: 'other-account' }), true);
});


test('a delayed old-component list cannot resolve a newer-generation pending commit', () => {
  const old = { ...CONTEXT, key_generation: 1 };
  const newer = { ...CONTEXT, key_generation: 2 };
  const pending = new Map([['token', old]]);
  const observedAtDispatch = pending.get('token');
  pending.set('token', newer); // Remount/reset/new ceremony before the old GET returns.
  assert.equal(reconcilePasskeyCommit(pending, 'token', observedAtDispatch, { ...CONFIG, key_generation: 1, credentials: [] }), 'stale');
  assert.equal(pending.get('token'), newer);
  assert.equal(reconcilePasskeyCommit(pending, 'token', newer, { ...CONFIG, key_generation: 2, credentials: [] }), 'unknown');
  assert.equal(pending.get('token'), newer);
  assert.equal(reconcilePasskeyCommit(pending, 'token', newer, { ...CONFIG, key_generation: 2, credentials: [newer] }), 'confirmed');
  assert.equal(pending.has('token'), false);
});


test('verified token rotation moves the same public pending record and fences old-token reads', () => {
  const record = { ...CONTEXT };
  const pending = new Map([['old-token', record]]);
  assert.equal(movePasskeyCommit(pending, 'old-token', 'rotated-token', 'rotated-token'), true);
  assert.equal(pending.get('rotated-token'), record);
  assert.equal(pending.has('old-token'), false);
  assert.equal(reconcilePasskeyCommit(pending, 'old-token', record, CONFIG), 'stale');
  assert.equal(pending.get('rotated-token'), record, 'Old response cannot clear the migrated pending record');
  const newer = { ...record, key_generation: record.key_generation + 1 };
  pending.set('rotated-token', newer);
  assert.equal(reconcilePasskeyCommit(pending, 'rotated-token', record, CONFIG), 'stale');
  assert.equal(pending.get('rotated-token'), newer, 'Old response cannot clear a newer pending record');
});

test('unsaved rotation and occupied destination never transfer or overwrite pending metadata', () => {
  const record = { ...CONTEXT };
  const other = { ...CONTEXT, account_id: 'other-account' };
  const pending = new Map([['old-token', record], ['other-token', other]]);
  assert.equal(movePasskeyCommit(pending, 'old-token', 'new-token', 'old-token'), false, 'Failed token save leaves active token unchanged');
  assert.equal(pending.get('old-token'), record);
  assert.equal(pending.has('new-token'), false);
  assert.equal(movePasskeyCommit(pending, 'old-token', 'other-token', 'other-token'), false);
  assert.equal(pending.get('old-token'), record);
  assert.equal(pending.get('other-token'), other);
  assert.equal(movePasskeyCommit(pending, 'old-token', '', ''), false);
  assert.equal(movePasskeyCommit(pending, 'old-token', 'old-token', 'old-token'), false);
});
