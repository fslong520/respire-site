import { deriveDataKeys, unwrapUrk } from './crypto.js';

// PRF results never cross the network boundary. Only this independent encrypted
// wrapper is stored on the server; the existing recovery wrapper is untouched.
const DOMAIN = 'respire:passkey:urk-wrap:v1';
const KDF = 'webauthn-prf-hkdf-sha256-v1';
const enc = value => new TextEncoder().encode(value);
const fail = code => Object.assign(new Error(code), { code });
const abort = () => new DOMException('Passkey operation superseded', 'AbortError');
export function assertPasskeyCurrent(signal, isCurrent = () => true) {
  if (signal?.aborted || !isCurrent()) throw abort();
}
export function passkeyAvailable() {
  // This only permits trying a ceremony. Actual PRF support is established from
  // extension results, including a fresh assertion, never a user-agent claim.
  return Boolean(globalThis.isSecureContext && globalThis.PublicKeyCredential
    && globalThis.navigator?.credentials?.create && globalThis.navigator?.credentials?.get
    && globalThis.crypto?.subtle);
}
export function encodeBase64url(value) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value)
    : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
  if (!bytes) throw fail('passkeyInvalidResponse');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeBase64url(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 65536) throw fail('passkeyInvalidResponse');
  let decoded;
  try { decoded = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
  catch { throw fail('passkeyInvalidResponse'); }
  if (encodeBase64url(decoded) !== value || (length !== undefined && decoded.length !== length)) throw fail('passkeyInvalidResponse');
  return decoded;
}

function metadata(value) {
  if (typeof value?.account_id !== 'string' || !value.account_id || value.account_id.length > 256
    || typeof value.rp_id !== 'string' || !value.rp_id || value.rp_id.length > 253
    || !Number.isSafeInteger(value.key_generation) || value.key_generation < 1) throw fail('passkeyInvalidResponse');
  decodeBase64url(value.credential_id);
  decodeBase64url(value.prf_salt, 32);
  return [DOMAIN, value.account_id, value.rp_id, value.credential_id, value.key_generation, value.prf_salt];
}
function sameMetadata(actual, expected) {
  if (JSON.stringify(metadata(actual)) !== JSON.stringify(metadata(expected))) throw fail('passkeyChanged');
}
export function validatePasskeyContext(value, vault, config, credentialId) {
  if (!config?.enabled || value?.account_id !== vault?.account_id
    || value?.account_id !== config.account_id || value?.rp_id !== config.rp_id
    || value?.key_generation !== vault?.key_generation || value?.key_generation !== config.key_generation
    || (credentialId !== undefined && value?.credential_id !== credentialId)) throw fail('passkeyChanged');
  if (typeof value.account_id !== 'string' || !value.account_id
    || typeof value.rp_id !== 'string' || !value.rp_id
    || !Number.isSafeInteger(value.key_generation) || value.key_generation < 1) throw fail('passkeyInvalidResponse');
}
export function validatePasskeyOrigin(config, location = globalThis.location) {
  if (!location || location.origin !== config?.origin
    || !(location.hostname === config.rp_id || location.hostname.endsWith(`.${config.rp_id}`))) throw fail('passkeyUnavailable');
}

async function kek(prf, context, usage) {
  if (!(prf instanceof Uint8Array) || prf.length !== 32) throw fail('passkeyNoPrf');
  metadata(context);
  const material = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: decodeBase64url(context.prf_salt, 32), info: enc(DOMAIN) },
    material, { name: 'AES-GCM', length: 256 }, false, [usage]);
}
export async function wrapPasskeyUrk(urk, prf, context) {
  if (!(urk instanceof Uint8Array) || urk.length !== 32) throw fail('passkeyInvalidResponse');
  const key = await kek(prf, context, 'encrypt');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc(JSON.stringify(metadata(context))), tagLength: 128 }, key, urk);
  return { version: 1, kdf: KDF, wrapped_urk: encodeBase64url(ciphertext), nonce: encodeBase64url(nonce) };
}
export async function unwrapPasskeyUrk(wrapper, prf, context) {
  if (wrapper?.version !== 1 || wrapper.kdf !== KDF) throw fail('passkeyInvalidResponse');
  const nonce = decodeBase64url(wrapper.nonce, 12);
  const ciphertext = decodeBase64url(wrapper.wrapped_urk, 48);
  const key = await kek(prf, context, 'decrypt');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc(JSON.stringify(metadata(context))), tagLength: 128 }, key, ciphertext));
}

const transports = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid']);
// Never call credential.toJSON(): browser serializers may include raw PRF output.
export function serializePasskeyCredential(credential, registration = false, enabled) {
  if (credential?.type !== 'public-key' || !credential.response) throw fail('passkeyInvalidResponse');
  const rawId = encodeBase64url(credential.rawId);
  if (credential.id !== rawId) throw fail('passkeyInvalidResponse');
  const source = credential.response;
  const response = { clientDataJSON: encodeBase64url(source.clientDataJSON) };
  if (registration) {
    response.attestationObject = encodeBase64url(source.attestationObject);
    if (typeof source.getTransports === 'function') response.transports = source.getTransports().filter(t => transports.has(t));
  } else {
    response.authenticatorData = encodeBase64url(source.authenticatorData);
    response.signature = encodeBase64url(source.signature);
    response.userHandle = source.userHandle == null ? null : encodeBase64url(source.userHandle);
  }
  return { id: rawId, rawId, type: 'public-key', response,
    clientExtensionResults: typeof enabled === 'boolean' ? { prf: { enabled } } : {} };
}
function byteView(value) {
  return value instanceof ArrayBuffer ? new Uint8Array(value)
    : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
}
function registrationPrfEnabled(credential) {
  const result = credential?.getClientExtensionResults?.()?.prf;
  // create is only capability evidence. Do not retain even unsolicited output.
  byteView(result?.results?.first)?.fill(0);
  byteView(result?.results?.second)?.fill(0);
  return result?.enabled === true;
}
function prfResult(credential) {
  const result = credential?.getClientExtensionResults?.()?.prf?.results;
  const bytes = byteView(result?.first);
  byteView(result?.second)?.fill(0);
  if (!bytes || bytes.length !== 32) { bytes?.fill(0); throw fail('passkeyNoPrf'); }
  return bytes;
}
function descriptors(list) {
  if (!Array.isArray(list)) return [];
  return list.map(item => ({ type: 'public-key', id: decodeBase64url(item.id),
    ...(Array.isArray(item.transports) ? { transports: item.transports.filter(t => transports.has(t)) } : {}) }));
}
export function creationOptions(envelope) {
  const source = envelope.public_key;
  if (source?.rp?.id !== envelope.rp_id || !source.user?.id || !Array.isArray(source.pubKeyCredParams)) throw fail('passkeyInvalidResponse');
  return { challenge: decodeBase64url(source.challenge), rp: { id: source.rp.id, name: source.rp.name },
    user: { id: decodeBase64url(source.user.id), name: source.user.name, displayName: source.user.displayName },
    pubKeyCredParams: source.pubKeyCredParams.map(({ type, alg }) => ({ type, alg })),
    excludeCredentials: descriptors(source.excludeCredentials), timeout: Math.min(source.timeout || 60000, 120000),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, attestation: 'none', extensions: { prf: {} } };
}
export function assertionOptions(envelope) {
  metadata(envelope);
  const source = envelope.public_key;
  if (source?.rpId !== envelope.rp_id) throw fail('passkeyInvalidResponse');
  const allowed = descriptors(source.allowCredentials);
  if (allowed.length !== 1 || encodeBase64url(allowed[0].id) !== envelope.credential_id) throw fail('passkeyInvalidResponse');
  return { challenge: decodeBase64url(source.challenge), rpId: source.rpId, allowCredentials: allowed,
    userVerification: 'required', timeout: Math.min(source.timeout || 60000, 120000),
    extensions: { prf: { eval: { first: decodeBase64url(envelope.prf_salt, 32) } } } };
}

export async function bindPasskey({ request, vault, config, superPass, secretKey, label, signal, isCurrent, credentials = globalThis.navigator?.credentials, onStage = () => {} }) {
  const current = () => assertPasskeyCurrent(signal, isCurrent);
  let urk, prf, reopenedPrf, roundtrip;
  try {
    current();
    validatePasskeyContext(config, vault, config);
    urk = await unwrapUrk(superPass, secretKey, vault);
    current();
    onStage('passkeyCreating');
    const start = await request('/register/start', { method: 'POST', body: { label }, signal });
    current(); validatePasskeyContext(start, vault, config);
    const registered = await credentials.create({ publicKey: creationOptions(start), signal });
    const enabled = registrationPrfEnabled(registered);
    current();
    if (!enabled) throw fail('passkeyNoPrf');
    const registration = serializePasskeyCredential(registered, true, enabled);
    const verify = await request('/register/finish', { method: 'POST', body: { ceremony_id: start.ceremony_id, credential: registration }, signal });
    current(); validatePasskeyContext(verify, vault, config, registration.id);
    onStage('passkeyVerifying');
    // Even a successful create is insufficient. Prove a fresh get can return the
    // PRF secret and decrypt the same URK before making this credential active.
    const assertion = await credentials.get({ publicKey: assertionOptions(verify), signal });
    prf = prfResult(assertion);
    current();
    const serialized = serializePasskeyCredential(assertion);
    if (serialized.id !== verify.credential_id) throw fail('passkeyChanged');
    const wrapper = await wrapPasskeyUrk(urk, prf, verify);
    current();
    // Test a second, separately challenged assertion, not merely encrypt/decrypt
    // with the same PRF buffer. A provider with unstable outputs fails closed.
    const reopen = await request('/register/test', { method: 'POST', body: { ceremony_id: verify.ceremony_id, credential: serialized }, signal });
    current(); validatePasskeyContext(reopen, vault, config, registration.id); sameMetadata(reopen, verify);
    prf.fill(0);
    onStage('passkeyReopening');
    const reopened = await credentials.get({ publicKey: assertionOptions(reopen), signal });
    reopenedPrf = prfResult(reopened);
    current();
    const reopenedCredential = serializePasskeyCredential(reopened);
    if (reopenedCredential.id !== verify.credential_id) throw fail('passkeyChanged');
    roundtrip = await unwrapPasskeyUrk(wrapper, reopenedPrf, reopen);
    current();
    if (roundtrip.length !== urk.length || roundtrip.some((byte, index) => byte !== urk[index])) throw fail('passkeyInvalidResponse');
    await request('/register/commit', { method: 'POST', body: { ceremony_id: reopen.ceremony_id, credential: reopenedCredential, wrapper }, signal });
    current();
  } finally {
    urk?.fill(0); prf?.fill(0); reopenedPrf?.fill(0); roundtrip?.fill(0);
  }
}

export async function unlockWithPasskey({ request, vault, config, credentialId, signal, isCurrent, credentials = globalThis.navigator?.credentials }) {
  const current = () => assertPasskeyCurrent(signal, isCurrent);
  let prf, urk, dataKey;
  let completed = false;
  try {
    current();
    const start = await request('/unlock/start', { method: 'POST', body: { credential_id: credentialId }, signal });
    current(); validatePasskeyContext(start, vault, config, credentialId);
    const assertion = await credentials.get({ publicKey: assertionOptions(start), signal });
    prf = prfResult(assertion);
    current();
    const serialized = serializePasskeyCredential(assertion);
    if (serialized.id !== credentialId) throw fail('passkeyChanged');
    const verified = await request('/unlock/finish', { method: 'POST', body: { ceremony_id: start.ceremony_id, credential: serialized }, signal });
    current(); validatePasskeyContext(verified, vault, config, credentialId); sameMetadata(verified, start);
    urk = await unwrapPasskeyUrk(verified.wrapper, prf, verified);
    current();
    dataKey = await deriveDataKeys(urk, vault.wrapped_urk.startsWith('rsrs:v1:'));
    current();
    completed = true;
    return dataKey;
  } finally {
    prf?.fill(0); urk?.fill(0);
    if (!completed) { dataKey?.legacy?.fill(0); dataKey?.current?.fill(0); }
  }
}
