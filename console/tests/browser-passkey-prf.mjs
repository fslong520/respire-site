import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Native browser WebAuthn + WebCrypto coverage with an ephemeral CDP virtual
// authenticator. No navigator.credentials replacement, request interception,
// real provider, account, service, or saved credential is used. The ceremony
// response fixture below checks wire shape/challenges but is NOT a signature
// verifier; signed backend verification has its own Rust integration tests.
async function within(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native PRF fixture timed out')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

const modules = new Map(await Promise.all(['crypto.js', 'passkeys.js', 'trustedBrowser.js', 'trustedKeyStore.js'].map(async name =>
  [`/${name}`, await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')])));
// Chromium permits WebAuthn over HTTP localhost (not an IP RP ID). This
// fixture server also acts as a fail-closed HTTP proxy: it serves only this
// exact localhost origin, never forwards requests, and never resolves DNS.
let origin;
const requests = [], blocked = [];
const server = createServer((req, res) => {
  let url;
  try { url = new URL(req.url); } catch { blocked.push(req.url); res.writeHead(403).end(); return; }
  if (url.origin !== origin || req.method !== 'GET' || req.headers.host !== url.host) {
    blocked.push(req.url); res.writeHead(403).end(); return;
  }
  requests.push(url.pathname);
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Synthetic Passkey PRF test</title>'); return; }
  if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
  if (!modules.has(url.pathname)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', 'text/javascript');
  res.end(modules.get(url.pathname));
});
for (const event of ['connect', 'upgrade']) server.on(event, (req, socket) => {
  blocked.push(req.url); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://localhost:${server.address().port}`;
const proxyOrigin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    ...(process.env.RSRS_BROWSER_EXECUTABLE ? { executablePath: process.env.RSRS_BROWSER_EXECUTABLE } : {}),
    headless: true,
    proxy: { server: proxyOrigin, bypass: '<-loopback>' },
  });
  for (const { supported, trusted } of [{ supported: true, trusted: false }, { supported: false, trusted: false }, { supported: false, trusted: true }]) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
        protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal',
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
        hasPrf: supported, automaticPresenceSimulation: true,
      } });
      await page.goto(origin);
      const result = await within(page.evaluate(async ({ supported, trusted }) => {
        const p = await import('/passkeys.js');
        const c = await import('/crypto.js');
        const t = trusted ? await import('/trustedBrowser.js') : null;
        const deviceId = trusted ? crypto.randomUUID() : undefined;
        const ensure = (condition, message) => { if (!condition) throw new Error(message); };
        const bytes = size => crypto.getRandomValues(new Uint8Array(size));
        const config = { enabled: true, trusted_browser_enabled: true, account_id: '00000000-0000-4000-8000-000000000001',
          rp_id: location.hostname, origin: location.origin, key_generation: 1 };
        const userHandle = p.encodeBase64url(Uint8Array.from(config.account_id.replaceAll('-', '').match(/../g), value => parseInt(value, 16)));
        const recovery = c.generateSecretKey();
        const urk = bytes(32);
        const vault = { ...await c.wrapVaultV4(recovery, urk), account_id: config.account_id, key_generation: 1 };
        const expectedKeys = await c.deriveDataKeys(urk, true);
        const memory = await c.encryptItem(expectedKeys, 'synthetic pre-existing memory');
        const originalVault = JSON.stringify(vault);
        let credentialId, wrapper, challenge, ceremony, assertions = 0, commits = 0, registrationPosts = 0;
        const prfSalt = p.encodeBase64url(bytes(32));
        const envelope = () => ({ ...config, credential_id: credentialId, ...(trusted ? { mode: 'trusted_browser', device_id: deviceId } : { prf_salt: prfSalt }) });
        const issue = registration => {
          challenge = p.encodeBase64url(bytes(32)); ceremony = crypto.randomUUID();
          return { ...envelope(), ceremony_id: ceremony, public_key: registration ? {
            challenge, rp: { id: config.rp_id, name: 'Synthetic Respire PRF' },
            user: { id: userHandle, name: 'synthetic-only', displayName: 'Synthetic Only' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }], excludeCredentials: [],
          } : { challenge, rpId: config.rp_id, allowCredentials: [{ type: 'public-key', id: credentialId }] } };
        };
        const request = async (path, { body }) => {
          if (trusted) ensure(body.mode === 'trusted_browser' && body.device_id === deviceId, 'Trusted mode/device binding mismatch');
          if (path === '/register/start') return issue(true);
          if (path === '/unlock/start') { ensure(body.credential_id === credentialId, 'Credential selection mismatch'); return issue(false); }
          ensure(body.ceremony_id === ceremony, 'Stale ceremony');
          const serialized = JSON.stringify(body.credential);
          ensure(!serialized.includes('"results"') && !serialized.includes('prf_output'), 'PRF output crossed API boundary');
          const data = JSON.parse(new TextDecoder().decode(p.decodeBase64url(body.credential.response.clientDataJSON)));
          ensure(data.challenge === challenge && data.origin === location.origin, 'Native client data mismatch');
          if (path === '/register/finish') {
            ensure(data.type === 'webauthn.create', 'Expected native creation');
            credentialId = body.credential.id; registrationPosts++;
            return issue(false);
          }
          ensure(data.type === 'webauthn.get' && body.credential.id === credentialId, 'Expected native assertion');
          ensure(body.credential.response.signature && body.credential.response.authenticatorData, 'Missing signed assertion');
          if (body.credential.response.userHandle !== null) ensure(body.credential.response.userHandle === userHandle, 'Native user handle mismatch');
          assertions++;
          if (path === '/register/test') return issue(false);
          if (path === '/register/commit') { wrapper = structuredClone(body.wrapper); commits++; return { ok: true }; }
          if (path === '/unlock/finish') return { ...envelope(), wrapper };
          throw new Error('Unexpected fixture route');
        };
        try {
          ensure(p.passkeyAvailable(), 'Loopback page must expose secure WebAuthn APIs');
          p.validatePasskeyOrigin(config);
          try {
            await (trusted ? t.bindTrustedBrowser : p.bindPasskey)({ request, vault, config, superPass: recovery, label: 'Synthetic only', isCurrent: () => true, ...(trusted ? { deviceId } : {}) });
            ensure(supported || trusted, 'Unsupported PRF must not bind in PRF mode');
          } catch (error) {
            if (supported || trusted || error.code !== 'passkeyPrfCreateUnavailable') throw error;
          }
          if (!supported && !trusted) {
            ensure(commits === 0 && registrationPosts === 0, 'Unsupported credential reached enrollment');
            const recovered = await c.unwrapUrk(recovery, undefined, vault);
            ensure(recovered.every((value, index) => value === urk[index]), 'Recovery fallback failed');
            recovered.fill(0);
            return { supported, fallback: true, commits };
          }
          ensure(commits === 1 && assertions === 2, 'Enrollment must perform two fresh assertions');
          const keys = await (trusted ? t.unlockWithTrustedBrowser : p.unlockWithPasskey)({ request, vault, config, credentialId, isCurrent: () => true, ...(trusted ? { deviceId } : {}) });
          try {
            ensure(await c.decryptItem(keys, memory.ciphertext, memory.nonce) === 'synthetic pre-existing memory', 'Existing memory decrypt failed');
          } finally { keys.legacy.fill(0); keys.current.fill(0); }
          ensure(JSON.stringify(vault) === originalVault, 'Enrollment changed recovery wrapper');
          ensure(localStorage.length === 0 && sessionStorage.length === 0, 'Unlock persisted browser storage');
          if (trusted) return { trusted: true, commits, assertions, fixture: { config, vault, credentialId, deviceId, wrapper, memory, userHandle } };
          return { supported, commits, assertions, sameVault: true, memoryDecrypted: true };
        } finally { urk.fill(0); expectedKeys.legacy.fill(0); expectedKeys.current.fill(0); }
      }, { supported, trusted }), 90000);
      if (trusted) {
        assert.equal(result.commits, 1); assert.equal(result.assertions, 3);
        await page.reload();
        const persisted = await within(page.evaluate(async f => {
          const p = await import('/passkeys.js');
          const c = await import('/crypto.js');
          const t = await import('/trustedBrowser.js');
          const { trustedKeyStore } = await import('/trustedKeyStore.js');
          const ensure = (condition, message) => { if (!condition) throw new Error(message); };
          const context = { ...f.config, mode: 'trusted_browser', credential_id: f.credentialId, device_id: f.deviceId };
          const key = await trustedKeyStore.read(context);
          ensure(key instanceof CryptoKey && key.extractable === false, 'Persistent key must be nonexportable');
          let exportRejected = false;
          try { await crypto.subtle.exportKey('raw', key); } catch { exportRejected = true; }
          ensure(exportRejected, 'Device key export unexpectedly succeeded');
          const database = await new Promise((resolve, reject) => {
            const opening = indexedDB.open('respire-trusted-browser-v1');
            opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
          });
          try {
            for (const name of database.objectStoreNames) {
              const rows = await new Promise((resolve, reject) => {
                const tx = database.transaction(name, 'readonly');
                const read = tx.objectStore(name).getAll();
                read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
              });
              const serialized = JSON.stringify(rows);
              ensure(!serialized.includes(f.wrapper.wrapped_urk) && !serialized.includes(f.vault.wrapped_urk), 'URK wrapper persisted in IndexedDB');
              ensure(!serialized.includes('wrapped_urk') && !serialized.includes('prf_output'), 'Secret-bearing storage field');
            }
          } finally { database.close(); }
          let challenge, ceremony, releases = 0, starts = 0;
          const request = async (path, { body }) => {
            ensure(body.mode === 'trusted_browser' && body.device_id === f.deviceId, 'Reload lost device binding');
            if (path === '/unlock/start') {
              starts++;
              ensure(body.credential_id === f.credentialId, 'Reload lost credential binding');
              challenge = p.encodeBase64url(crypto.getRandomValues(new Uint8Array(32))); ceremony = crypto.randomUUID();
              return { ...context, ceremony_id: ceremony, public_key: { challenge, rpId: f.config.rp_id, allowCredentials: [{ type: 'public-key', id: f.credentialId }] } };
            }
            ensure(path === '/unlock/finish' && body.ceremony_id === ceremony, 'Unexpected reload ceremony');
            const cd = JSON.parse(new TextDecoder().decode(p.decodeBase64url(body.credential.response.clientDataJSON)));
            ensure(cd.type === 'webauthn.get' && cd.challenge === challenge && cd.origin === location.origin, 'Fresh native reload assertion required');
            ensure(body.credential.id === f.credentialId && body.credential.response.signature, 'Reload assertion missing');
            ensure(!JSON.stringify(body).includes('\"results\"'), 'Secret extension serialized');
            releases++; return { ...context, wrapper: f.wrapper };
          };
          const keys = await t.unlockWithTrustedBrowser({ request, vault: f.vault, config: f.config, credentialId: f.credentialId, deviceId: f.deviceId, isCurrent: () => true });
          try { ensure(await c.decryptItem(keys, f.memory.ciphertext, f.memory.nonce) === 'synthetic pre-existing memory', 'Reload trusted decrypt failed'); }
          finally { keys.legacy.fill(0); keys.current.fill(0); }
          ensure(releases === 1, 'Wrapper released without exactly one fresh assertion');
          ensure(localStorage.length === 0 && sessionStorage.length === 0, 'Trust must not populate general browser storage');
          await trustedKeyStore.clearAll();
          ensure(await trustedKeyStore.read(context) === null, 'Forgotten device key survived');
          let missing = false;
          try { await t.unlockWithTrustedBrowser({ request, vault: f.vault, config: f.config, credentialId: f.credentialId, deviceId: f.deviceId, isCurrent: () => true }); }
          catch (error) { missing = error.code === 'trustedKeyMissing'; }
          ensure(missing && starts === 1 && releases === 1, 'Missing local key must fail before another native ceremony');
          return { reloaded: true, nonexportable: true, memoryDecrypted: true, forgotten: true };
        }, result.fixture), 90000);
        assert.deepEqual(persisted, { reloaded: true, nonexportable: true, memoryDecrypted: true, forgotten: true });
      } else if (supported) assert.deepEqual(result, { supported: true, commits: 1, assertions: 3, sameVault: true, memoryDecrypted: true });
      else assert.deepEqual(result, { supported: false, fallback: true, commits: 0 });
      console.log(trusted ? 'PASS native no-PRF WebAuthn trusted-browser enrollment, IndexedDB reload, unlock and forget' : `PASS native virtual WebAuthn PRF ${supported ? 'enrollment, reopen and memory unlock' : 'unsupported fallback'}`);
    } finally { await context.close(); }
  }
  assert.deepEqual(blocked, [], 'Unexpected network destination');
  assert.ok(requests.includes('/passkeys.js'), 'Native module load must traverse fixture proxy');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
