import { deriveDataKeys, unwrapUrk } from './crypto.js';
import { assertPasskeyCurrent, creationOptions, decodeBase64url, encodeBase64url, serializePasskeyCredential, validatePasskeyContext } from './passkeys.js';
import { trustedKeyStore } from './trustedKeyStore.js';

const DOMAIN = 'respire:trusted-browser:urk-wrap:v1';
const KDF = 'trusted-browser-aes256gcm-v1';
const fail = code => Object.assign(new Error(code), { code });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const transportTypes = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid']);
const fields = value => {
  if (value?.mode !== 'trusted_browser' || typeof value.account_id !== 'string' || !value.account_id
    || typeof value.rp_id !== 'string' || !value.rp_id || !uuid.test(value.device_id)
    || !Number.isSafeInteger(value.key_generation) || value.key_generation < 1) throw fail('passkeyInvalidResponse');
  decodeBase64url(value.credential_id);
  return [DOMAIN, value.account_id, value.rp_id, value.credential_id, value.key_generation, value.device_id];
};
const aad = value => new TextEncoder().encode(JSON.stringify(fields(value)));
function sameContext(actual, expected) {
  if (JSON.stringify(fields(actual)) !== JSON.stringify(fields(expected))) throw fail('passkeyChanged');
}
function context(value, vault, config, deviceId, credentialId) {
  validatePasskeyContext(value, vault, config, credentialId);
  if (!config.trusted_browser_enabled || value.mode !== 'trusted_browser' || value.device_id !== deviceId || !uuid.test(deviceId)) throw fail('passkeyChanged');
}
function keyValid(key) {
  if (!key || key.type !== 'secret' || key.extractable !== false || key.algorithm?.name !== 'AES-GCM'
    || key.algorithm.length !== 256 || key.usages.length !== 2 || !key.usages.includes('encrypt') || !key.usages.includes('decrypt')) throw fail('trustedKeyMissing');
}
export async function wrapTrustedUrk(urk, key, metadata) {
  keyValid(key);
  if (!(urk instanceof Uint8Array) || urk.length !== 32) throw fail('passkeyInvalidResponse');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(metadata), tagLength: 128 }, key, urk);
  return { version: 1, kdf: KDF, wrapped_urk: encodeBase64url(wrapped), nonce: encodeBase64url(nonce) };
}
export async function unwrapTrustedUrk(wrapper, key, metadata) {
  keyValid(key);
  if (wrapper?.version !== 1 || wrapper.kdf !== KDF) throw fail('passkeyInvalidResponse');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decodeBase64url(wrapper.nonce, 12),
    additionalData: aad(metadata), tagLength: 128 }, key, decodeBase64url(wrapper.wrapped_urk, 48)));
}
function creation(envelope) {
  const options = creationOptions(envelope);
  // Ordinary WebAuthn UV authenticates this browser's enrollment; it is not
  // used as encryption key material and does not pretend to provide PRF.
  options.extensions = {};
  return options;
}
function assertion(envelope) {
  fields(envelope);
  const source = envelope.public_key;
  if (source?.rpId !== envelope.rp_id || !Array.isArray(source.allowCredentials) || source.allowCredentials.length !== 1
    || source.allowCredentials[0].id !== envelope.credential_id) throw fail('passkeyInvalidResponse');
  const allowed = source.allowCredentials[0];
  return { challenge: decodeBase64url(source.challenge), rpId: source.rpId, userVerification: 'required',
    timeout: Math.min(source.timeout || 60000, 120000), extensions: {}, allowCredentials: [{ type: 'public-key',
      id: decodeBase64url(allowed.id), ...(Array.isArray(allowed.transports) ? { transports: allowed.transports.filter(t => transportTypes.has(t)) } : {}) }] };
}
function serialize(credential, registration = false) {
  const prf = credential?.getClientExtensionResults?.()?.prf?.results;
  for (const value of [prf?.first, prf?.second]) {
    if (value instanceof ArrayBuffer) new Uint8Array(value).fill(0);
    else if (ArrayBuffer.isView(value)) new Uint8Array(value.buffer, value.byteOffset, value.byteLength).fill(0);
  }
  return serializePasskeyCredential(credential, registration);
}
const publicContext = value => ({ mode: 'trusted_browser', account_id: value.account_id, rp_id: value.rp_id,
  credential_id: value.credential_id, key_generation: value.key_generation, device_id: value.device_id });

export async function bindTrustedBrowser({ request, vault, config, superPass, secretKey, label, signal, isCurrent,
  credentials = globalThis.navigator?.credentials, keyStore = trustedKeyStore, deviceId = crypto.randomUUID(), onStage = () => {} }) {
  const current = () => assertPasskeyCurrent(signal, isCurrent);
  const guard = { signal, isCurrent };
  const mode = { mode: 'trusted_browser', device_id: deviceId };
  let urk, roundtrip, storedContext, commitDispatched = false;
  try {
    current();
    if (!config?.trusted_browser_enabled || !uuid.test(deviceId)) throw fail('trustedBrowserDisabled');
    validatePasskeyContext(config, vault, config);
    urk = await unwrapUrk(superPass, secretKey, vault);
    current(); onStage('passkeyCreating');
    const start = await request('/register/start', { method: 'POST', body: { label, ...mode }, signal });
    current(); context(start, vault, config, deviceId);
    const registered = await credentials.create({ publicKey: creation(start), signal });
    const registration = serialize(registered, true);
    current();
    const verify = await request('/register/finish', { method: 'POST', body: { ceremony_id: start.ceremony_id, credential: registration, ...mode }, signal });
    current(); context(verify, vault, config, deviceId, registration.id); fields(verify);
    storedContext = publicContext(verify);
    onStage('trustedBrowserSaving');
    // Persistence and independent readback must succeed BEFORE activation.
    const key = await keyStore.create(storedContext, guard);
    current(); onStage('passkeyVerifying');
    const first = serialize(await credentials.get({ publicKey: assertion(verify), signal }));
    current(); if (first.id !== registration.id) throw fail('passkeyChanged');
    const wrapper = await wrapTrustedUrk(urk, key, verify);
    current();
    const reopen = await request('/register/test', { method: 'POST', body: { ceremony_id: verify.ceremony_id, credential: first, ...mode }, signal });
    current(); context(reopen, vault, config, deviceId, registration.id); sameContext(reopen, verify);
    onStage('passkeyReopening');
    const second = serialize(await credentials.get({ publicKey: assertion(reopen), signal }));
    current(); if (second.id !== registration.id) throw fail('passkeyChanged');
    const reopenedLease = await keyStore.readLease(storedContext, guard);
    current();
    if (!reopenedLease) throw fail('trustedKeyMissing');
    roundtrip = await unwrapTrustedUrk(wrapper, reopenedLease.key, reopen);
    current();
    if (roundtrip.length !== urk.length || roundtrip.some((byte, index) => byte !== urk[index])) throw fail('passkeyInvalidResponse');
    await reopenedLease.assertCurrent();
    current();
    onStage('passkeyCommitting', storedContext);
    commitDispatched = true;
    await request('/register/commit', { method: 'POST', body: { ceremony_id: reopen.ceremony_id, credential: second, wrapper, ...mode }, signal });
    current();
    await keyStore.markActive(storedContext, registration.id, guard);
    current();
    return storedContext;
  } catch (error) {
    if (commitDispatched) throw Object.assign(fail('passkeyCommitUnknown'), { cause: error });
    if (storedContext) {
      try { await keyStore.remove(storedContext); }
      catch { throw Object.assign(fail('trustedCleanupFailed'), { cause: error }); }
    }
    throw error;
  } finally { urk?.fill(0); roundtrip?.fill(0); }
}

export async function unlockWithTrustedBrowser({ request, vault, config, credentialId, deviceId, signal, isCurrent,
  credentials = globalThis.navigator?.credentials, keyStore = trustedKeyStore, onKeyLease = () => {} }) {
  const current = () => assertPasskeyCurrent(signal, isCurrent);
  const mode = { mode: 'trusted_browser', device_id: deviceId };
  let urk, dataKey, complete = false;
  try {
    current();
    if (!config?.trusted_browser_enabled) throw fail('trustedBrowserDisabled');
    validatePasskeyContext(config, vault, config);
    const expected = { ...config, ...mode, credential_id: credentialId };
    fields(expected);
    // Missing/cleared storage must fail before a needless native prompt.
    const key = await keyStore.read(expected, { signal, isCurrent });
    current(); keyValid(key);
    const start = await request('/unlock/start', { method: 'POST', body: { credential_id: credentialId, ...mode }, signal });
    current(); context(start, vault, config, deviceId, credentialId); sameContext(start, expected);
    const credential = serialize(await credentials.get({ publicKey: assertion(start), signal }));
    current(); if (credential.id !== credentialId) throw fail('passkeyChanged');
    const verified = await request('/unlock/finish', { method: 'POST', body: { ceremony_id: start.ceremony_id, credential, ...mode }, signal });
    current(); context(verified, vault, config, deviceId, credentialId); sameContext(verified, start);
    // Read again: logout/reset/removal during the server request invalidates the
    // durable key even if an earlier CryptoKey reference is still in this stack.
    const lease = await keyStore.readLease(expected, { signal, isCurrent });
    current();
    if (!lease) throw fail('trustedKeyMissing');
    urk = await unwrapTrustedUrk(verified.wrapper, lease.key, verified);
    current();
    dataKey = await deriveDataKeys(urk, vault.wrapped_urk.startsWith('rsrs:v1:'));
    await lease.assertCurrent();
    current(); onKeyLease({ assertCurrent: lease.assertCurrent }); complete = true;
    return dataKey;
  } finally {
    urk?.fill(0);
    if (!complete) { dataKey?.legacy?.fill(0); dataKey?.current?.fill(0); }
  }
}

// This association is authenticated, page-memory-only bookkeeping for logout.
// Durable keys are always scoped by immutable account ID, never an API token.
const tokenAccounts = new Map();
// Resolve the exact authenticated token's public identity before enabling
// logout on routes that do not otherwise load the vault. This optional lookup
// never inherits another token's mapping and never changes global auth state.
export function resolveTrustedAccount({ token, request, signal, isCurrent, timeoutMs = 5000 }) {
  return new Promise(resolve => {
    const controller = new AbortController();
    let settled = false, timer, deadline = Infinity;
    const now = () => globalThis.performance.now();
    const current = () => {
      try { return typeof isCurrent === 'function' && isCurrent() === true && !settled && !signal?.aborted && now() < deadline; }
      catch { return false; }
    };
    const finish = success => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!success) controller.abort();
      resolve(success);
    };
    const onAbort = () => finish(false);
    if (typeof token !== 'string' || !token || typeof request !== 'function' || !current()) { finish(false); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    const delay = Number.isFinite(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 2147483647 ? timeoutMs : 5000;
    deadline = now() + delay;
    timer = setTimeout(() => finish(false), delay);
    // The separate deadline resolves even when a request ignores its signal.
    // Every terminal path fences the continuation before attempting to abort.
    void (async () => {
      try {
        if (!current()) { finish(false); return; }
        const vault = await request('/api/self/vault', { token, signal: controller.signal, notifyUnauthorized: false });
        const accountId = vault?.account_id;
        if (!current() || typeof accountId !== 'string' || !accountId || accountId.length > 256
          || /[\s\u0000-\u001f\u007f]/u.test(accountId)) { finish(false); return; }
        // No asynchronous work between the final token/generation guard and
        // this page-memory-only association.
        tokenAccounts.set(token, accountId);
        finish(true);
      } catch { finish(false); }
    })();
  });
}
export function rememberTrustedAccount(token, accountId) {
  if (token && typeof accountId === 'string' && accountId.length > 0 && accountId.length <= 256) tokenAccounts.set(token, accountId);
}
export function moveTrustedAccount(from, to, activeToken) {
  if (activeToken !== to || !to || from === to || tokenAccounts.has(to)) return;
  if (tokenAccounts.has(from)) tokenAccounts.set(to, tokenAccounts.get(from));
  tokenAccounts.delete(from);
}
export function forgetTrustedAccount(token, keyStore = trustedKeyStore, { passive = false } = {}) {
  const accountId = tokenAccounts.get(token);
  tokenAccounts.delete(token);
  // Only the initiating logout owns durable cleanup. A receiving tab may have
  // no UUID mapping, or process this event after a newer enrollment has finished.
  if (passive) return { allAccounts: false, completion: Promise.resolve({ clearedRecords: 0 }) };
  return { allAccounts: !accountId, completion: accountId ? keyStore.clearAccount(accountId) : keyStore.clearAll() };
}
