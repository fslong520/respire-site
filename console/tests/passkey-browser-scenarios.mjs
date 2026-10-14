import assert from 'node:assert/strict';
import { generateSecretKey, wrapVaultV4, unwrapUrk } from '../src/crypto.js';
import { t, setLocale } from '../src/i18n.js';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FIXTURE } from './fixture-api.mjs';

// Deliberately synthetic navigator.credentials implementation. This tests the
// actual built React UI, WebCrypto and HTTP transport, not provider support or
// server WebAuthn signature verification. No credential response is routed/mock-
// fulfilled through Playwright; all API calls reach the loopback fixture server.
async function syntheticProvider(page) {
  await page.evaluate(() => {
    window.passkeyFixture = { mode: 'normal', creates: 0, gets: 0, ceremonyGets: 0, resolve: null };
    const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const credential = (id, registration) => {
      const result = new Uint8Array(32).fill(91);
      const missing = window.passkeyFixture.mode === 'missing' || (window.passkeyFixture.mode === 'missingSecond' && window.passkeyFixture.ceremonyGets === 2);
      // Provider-shaped outputs: enabled only exists on create. Bitwarden's
      // versioned provider implementation supplies no PRF extension at all.
      const extensions = registration ? (window.passkeyFixture.mode === 'unsupported' ? {} : { prf: { enabled: true } })
        : window.passkeyFixture.mode === 'unsupported' ? {} : { prf: missing ? {} : { results: { first: result.buffer } } };
      return { id: b64(id), rawId: id, type: 'public-key',
        response: { clientDataJSON: new Uint8Array(16).fill(1), ...(registration
          ? { attestationObject: new Uint8Array(64).fill(2), getTransports: () => ['internal'] }
          : { authenticatorData: new Uint8Array(37).fill(3), signature: new Uint8Array(64).fill(4), userHandle: null }) },
        getClientExtensionResults: () => extensions,
        toJSON() { throw new Error('Unsafe credential serializer called'); } };
    };
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: {
      create: async () => { window.passkeyFixture.creates++; window.passkeyFixture.ceremonyGets = 0; return credential(new Uint8Array(24).fill(window.passkeyFixture.creates), true); },
      get: async ({ publicKey }) => {
        window.passkeyFixture.gets++; window.passkeyFixture.ceremonyGets++;
        if (window.passkeyFixture.mode === 'cancel') throw new DOMException('Synthetic cancellation', 'NotAllowedError');
        const value = credential(new Uint8Array(publicKey.allowCredentials[0].id), false);
        if (window.passkeyFixture.mode === 'delay') return new Promise(resolve => { window.passkeyFixture.resolve = () => resolve(value); });
        return value;
      },
    } });
  });
}
async function enroll(page, recovery, label, trusted = false) {
  await page.getByRole('button', { name: t('passkeyBind'), exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(t('labelSuperA3'), { exact: true }).fill(recovery);
  if (label) await dialog.getByLabel(t('passkeyLabel'), { exact: true }).fill(label);
  if (trusted) await dialog.getByLabel(t('trustedBrowserMode'), { exact: true }).selectOption('trusted_browser');
  await dialog.getByRole('button', { name: t('passkeyBind'), exact: true }).click();
  return dialog;
}
const nav = (page, destination) => page.getByRole('navigation', { name: t('mainNav'), exact: true })
  .locator(`a[href="#/${destination}"]`).click();
async function noRecoveryStorage(page, recovery) {
  const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  assert.ok(!storage.includes(recovery));
  assert.ok(!storage.includes('wrapped_urk'));
  assert.ok(!storage.includes('prf_salt'));
}

async function localTrustedRecords(page, clear = false) {
  return page.evaluate(clear => new Promise((resolve, reject) => {
    const request = indexedDB.open('respire-trusted-browser-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('keys')) { db.close(); resolve([]); return; }
      const tx = db.transaction('keys', clear ? 'readwrite' : 'readonly');
      const store = tx.objectStore('keys');
      const query = clear ? store.clear() : store.getAll();
      let records = [];
      query.onsuccess = () => { if (!clear) records = query.result.map(record => ({
        account_id: record.account_id, device_id: record.device_id, key_generation: record.key_generation,
        active: record.active, fields: Object.keys(record).sort(), extractable: record.key.extractable,
        algorithm: record.key.algorithm.name, keyLength: record.key.algorithm.length,
      })); };
      tx.oncomplete = () => { db.close(); resolve(records); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), clear);
}
async function waitLocalCount(page, count) {
  for (let i = 0; i < 100; i++) {
    const records = await localTrustedRecords(page);
    if (records.length === count) return records;
    await page.waitForTimeout(20);
  }
  assert.equal((await localTrustedRecords(page)).length, count);
}

export async function passkeyBrowserScenarios({ run, open, api }) {
  const setup = async (storage = {}) => {
    // The fixture retains its request log for the final cross-origin audit.
    // Every scenario asserts its own delta without clearing that audit trail.
    const requestStart = api.requests.length;
    api.state.passkeysEnabled = true;
    const recovery = generateSecretKey();
    api.state.vault = await wrapVaultV4(recovery);
    const page = await open('/dashboard/keys', { ...storage, 'rsrs.userToken': FIXTURE.userToken });
    await syntheticProvider(page);
    await page.getByRole('button', { name: t('passkeyBind'), exact: true }).waitFor();
    return { recovery, page, requests: () => api.requests.slice(requestStart) };
  };
  for (const locale of ['en', 'zh']) for (const width of [1440, 390]) {
    await run(`passkey settings: ${locale} at ${width}px stays compact and opts in explicitly`, async () => {
      api.state.trustedBrowserEnabled = true;
      const { page, requests } = await setup();
      await page.setViewportSize({ width, height: 1000 });
      if (locale === 'zh') await page.getByRole('button', { name: '中文', exact: true }).click();
      setLocale(locale);
      try {
        const panel = page.locator('.passkey-panel');
        await panel.getByRole('heading', { name: t('passkeyTitle'), exact: true }).waitFor();
        assert.equal(await panel.getByText(t('trustedBrowserConsent'), { exact: true }).count(), 0);
        assert.equal(await panel.getByText(t('passkeyPrfRequirement'), { exact: true }).count(), 0);
        assert.equal(await panel.getByRole('link').count(), 0);
        assert.ok(!(await panel.textContent()).includes('Bitwarden'));
        assert.equal(await panel.locator('.button.primary').count(), 1);
        const sizes = await page.locator('.memory-key-panel > p, .passkey-panel > p').evaluateAll(nodes => nodes.map(n => getComputedStyle(n).fontSize));
        assert.ok(sizes.length >= 2 && sizes.every(size => size === sizes[0]));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (process.env.RSRS_UI_SCREENSHOTS) {
          await mkdir(process.env.RSRS_UI_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: resolve(process.env.RSRS_UI_SCREENSHOTS, `passkey-${locale}-${width}.png`), fullPage: true });
        }
        await panel.getByRole('button', { name: t('passkeyBind'), exact: true }).click();
        const dialog = page.getByRole('dialog');
        const select = dialog.getByLabel(t('trustedBrowserMode'), { exact: true });
        assert.equal(await select.inputValue(), 'prf');
        await dialog.getByText(t('passkeyPrfRequirement'), { exact: true }).waitFor();
        assert.equal(await dialog.getByText(t('trustedBrowserConsent'), { exact: true }).count(), 0);
        await select.selectOption('trusted_browser');
        await dialog.getByText(t('trustedBrowserConsent'), { exact: true }).waitFor();
        assert.equal(await dialog.getByText(t('passkeyPrfRequirement'), { exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => window.passkeyFixture.creates), 0);
        assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false);
        if (process.env.RSRS_UI_SCREENSHOTS) await page.screenshot({ path: resolve(process.env.RSRS_UI_SCREENSHOTS, `passkey-consent-${locale}-${width}.png`) });
        await dialog.getByRole('button', { name: t('cancel'), exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await panel.getByRole('button', { name: t('passkeyBind'), exact: true }).click();
        assert.equal(await page.getByRole('dialog').getByLabel(t('trustedBrowserMode'), { exact: true }).inputValue(), 'prf');
        await page.getByRole('dialog').getByRole('button', { name: t('closeDialog'), exact: true }).click();
        assert.equal(requests().filter(r => r.method === 'POST' && r.path.includes('/passkeys')).length, 0);
        assert.equal((await localTrustedRecords(page)).length, 0);
      } finally { setLocale('en'); }
    });
  }
  await run('passkeys: unsupported PRF offers an explicit trusted-browser switch without an automatic retry', async () => {
    api.state.trustedBrowserEnabled = true;
    const { recovery, page, requests } = await setup();
    await page.evaluate(() => { window.passkeyFixture.mode = 'unsupported'; });
    const dialog = await enroll(page, recovery, 'Unsupported provider');
    await dialog.getByRole('alert').filter({ hasText: t('passkeyPrfCreateUnavailable') }).waitFor();
    assert.equal(api.state.passkeys.size, 0);
    assert.equal(await page.evaluate(() => window.passkeyFixture.creates), 1);
    assert.equal(await dialog.getByRole('button', { name: t('passkeyBind'), exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: t('trustedBrowserSwitch'), exact: true }).click();
    await dialog.getByText(t('trustedBrowserConsent'), { exact: true }).waitFor();
    assert.equal(await dialog.getByLabel(t('labelSuperA3'), { exact: true }).inputValue(), '');
    assert.equal(await page.evaluate(() => window.passkeyFixture.creates), 1);
    assert.equal(api.state.passkeys.size, 0);
    await dialog.getByLabel(t('trustedBrowserMode'), { exact: true }).selectOption('prf');
    assert.equal(await dialog.getByRole('button', { name: t('passkeyBind'), exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: t('cancel'), exact: true }).click();
    assert.equal((await localTrustedRecords(page)).length, 0);
    await page.getByRole('button', { name: t('passkeyBind'), exact: true }).click();
    assert.equal(await page.getByRole('dialog').getByLabel(t('trustedBrowserMode'), { exact: true }).inputValue(), 'prf');
    await page.getByRole('dialog').getByRole('button', { name: t('cancel'), exact: true }).click();
    // A fresh user-started attempt may recheck PRF; no failure path retries it.
    const next = await enroll(page, recovery, 'Explicit browser trust');
    await next.getByRole('alert').filter({ hasText: t('passkeyPrfCreateUnavailable') }).waitFor();
    await next.getByRole('button', { name: t('trustedBrowserSwitch'), exact: true }).click();
    await next.getByLabel(t('labelSuperA3'), { exact: true }).fill(generateSecretKey());
    await next.getByRole('button', { name: t('passkeyBind'), exact: true }).click();
    await next.getByRole('alert').waitFor();
    await next.getByLabel(t('trustedBrowserMode'), { exact: true }).selectOption('prf');
    assert.equal(await next.getByRole('button', { name: t('passkeyBind'), exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.passkeyFixture.creates), 2);
    await next.getByRole('button', { name: t('trustedBrowserSwitch'), exact: true }).click();
    await next.getByLabel(t('labelSuperA3'), { exact: true }).fill(recovery);
    await next.getByRole('button', { name: t('passkeyBind'), exact: true }).click();
    await next.waitFor({ state: 'hidden' });
    assert.equal(api.state.passkeys.size, 1);
    assert.equal([...api.state.passkeys.values()][0].mode, 'trusted_browser');
    assert.equal(await page.evaluate(() => window.passkeyFixture.creates), 3);
    assert.ok(requests().some(r => r.method === 'POST' && r.path.endsWith('/register/start') && r.body?.mode === 'trusted_browser'));
  });
  const twoTrustedAccounts = async () => {
    api.state.trustedBrowserEnabled = true;
    const fixture = await setup({ 'rsrs.dashboard.accounts': JSON.stringify([
      { user: FIXTURE.user, token: FIXTURE.userToken }, { user: FIXTURE.secondUser, token: FIXTURE.secondToken },
    ]) });
    const { page, recovery } = fixture;
    await (await enroll(page, recovery, 'Account A identity fixture', true)).waitFor({ state: 'hidden' });
    await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(FIXTURE.secondToken);
    await page.waitForFunction(token => localStorage.getItem('rsrs.userToken') === token, FIXTURE.secondToken);
    await nav(page, 'keys');
    await page.getByRole('button', { name: t('passkeyBind'), exact: true }).and(page.locator(':enabled')).waitFor();
    await (await enroll(page, recovery, 'Account B identity fixture', true)).waitFor({ state: 'hidden' });
    await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(FIXTURE.userToken);
    await page.waitForFunction(token => localStorage.getItem('rsrs.userToken') === token, FIXTURE.userToken);
    await nav(page, 'sessions');
    return fixture;
  };
  const receivingSessionsTab = async page => {
    const passive = await page.context().newPage(), errors = [];
    passive.setDefaultTimeout(10000); passive.on('pageerror', error => errors.push(error.message));
    await passive.goto(new URL('/dashboard#/sessions', page.url()).href);
    await passive.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).waitFor();
    return { passive, errors };
  };

  await run('trusted browser: explicit opt-in accepts non-PRF passkeys and survives reload with only a local CryptoKey', async () => {
    api.state.trustedBrowserEnabled = true;
    const { page, recovery, requests } = await setup();
    const original = structuredClone(api.state.vault);
    await page.evaluate(() => { window.passkeyFixture.mode = 'unsupported'; });
    await page.getByRole('button', { name: t('passkeyBind'), exact: true }).click();
    let dialog = page.getByRole('dialog');
    assert.equal(await dialog.getByLabel(t('trustedBrowserMode'), { exact: true }).inputValue(), 'prf');
    await dialog.getByRole('button', { name: t('cancel'), exact: true }).click();
    await (await enroll(page, recovery, 'Ordinary provider with browser trust', true)).waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.passkeyFixture.gets), 2);
    const records = await waitLocalCount(page, 1);
    assert.equal(records[0].extractable, false); assert.equal(records[0].algorithm, 'AES-GCM'); assert.equal(records[0].keyLength, 256);
    assert.deepEqual(records[0].fields, ['account_id', 'active', 'credential_id', 'device_id', 'id', 'key', 'key_generation', 'revision', 'rp_id']);
    assert.deepEqual(api.state.vault, original);
    await page.reload(); await syntheticProvider(page);
    await page.evaluate(() => { window.passkeyFixture.mode = 'unsupported'; });
    await nav(page, 'memories');
    await page.getByRole('button', { name: t('passkeyUnlock'), exact: true }).and(page.locator(':enabled')).click();
    await page.locator('.empty-guide').waitFor();
    assert.equal(requests().filter(r => r.method === 'POST' && r.path.endsWith('/unlock/finish')).length, 1);
    const sent = JSON.stringify(requests().filter(r => r.path.startsWith('/api/self/passkeys')).map(r => r.body));
    assert.equal(sent.includes('results'), false); assert.equal(sent.includes('"key"'), false);
    await noRecoveryStorage(page, recovery);
  });

  await run('trusted browser: lost local key needs recovery without another native prompt', async () => {
    api.state.trustedBrowserEnabled = true;
    const { page, recovery, requests } = await setup();
    await page.evaluate(() => { window.passkeyFixture.mode = 'unsupported'; });
    await (await enroll(page, recovery, 'Storage loss', true)).waitFor({ state: 'hidden' });
    await localTrustedRecords(page, true);
    await nav(page, 'memories');
    await page.getByRole('button', { name: t('passkeyUnlock'), exact: true }).and(page.locator(':enabled')).click();
    await page.getByRole('alert').filter({ hasText: t('trustedKeyMissing') }).waitFor();
    assert.equal(await page.evaluate(() => window.passkeyFixture.gets), 2);
    assert.equal(requests().filter(r => r.method === 'POST' && r.path.includes('/unlock/')).length, 0);
    assert.equal(api.state.passkeys.size, 1);
  });

  await run('trusted browser: IndexedDB write failure cannot activate a binding', async () => {
    api.state.trustedBrowserEnabled = true;
    const { page, recovery, requests } = await setup();
    await page.evaluate(() => {
      window.passkeyFixture.mode = 'unsupported';
      const original = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (...args) {
        if (this.name === 'keys') throw new DOMException('Synthetic storage denied', 'QuotaExceededError');
        return original.apply(this, args);
      };
    });
    const dialog = await enroll(page, recovery, 'Storage rejected', true);
    await dialog.getByRole('alert').filter({ hasText: t('trustedBrowserStorageUnavailable') }).waitFor();
    assert.equal(await page.evaluate(() => window.passkeyFixture.gets), 0);
    assert.equal(requests().filter(r => r.method === 'POST' && r.path.endsWith('/register/commit')).length, 0);
    assert.equal(api.state.passkeys.size, 0); await waitLocalCount(page, 0);
    await dialog.getByRole('button', { name: t('cancel'), exact: true }).click();
  });

  await run('trusted browser: pre-commit cancellation deletes local pending key and ignores late native result', async () => {
    api.state.trustedBrowserEnabled = true;
    const { page, recovery, requests } = await setup();
    await page.evaluate(() => { window.passkeyFixture.mode = 'delay'; });
    const dialog = await enroll(page, recovery, 'Cancelled local setup', true);
    await page.waitForFunction(() => !!window.passkeyFixture.resolve);
    await waitLocalCount(page, 1);
    await dialog.getByRole('button', { name: t('cancel'), exact: true }).click();
    await page.evaluate(() => window.passkeyFixture.resolve());
    await waitLocalCount(page, 0);
    assert.equal(api.state.passkeys.size, 0);
    assert.equal(requests().filter(r => r.method === 'POST' && r.path.endsWith('/register/commit')).length, 0);
  });

  await run('trusted browser: uncertain accepted commit retains and reconciles the local key', async () => {
    api.state.trustedBrowserEnabled = true;
    const { page, recovery, requests } = await setup();
    api.state.passkeyCommitResponseLost = true;
    await page.evaluate(() => { window.passkeyFixture.mode = 'unsupported'; });
    await (await enroll(page, recovery, 'Unknown local setup', true)).waitFor({ state: 'hidden' });
    await page.getByText(t('passkeyCommitFound'), { exact: true }).waitFor();
    const records = await waitLocalCount(page, 1); assert.equal(records[0].active, true);
    assert.equal(requests().filter(r => r.method === 'POST' && r.path.endsWith('/register/commit')).length, 1);
    assert.equal(requests().filter(r => r.method === 'POST' && r.path.endsWith('/remove')).length, 0);
    await noRecoveryStorage(page, recovery);
  });

  await run('trusted browser: account switching isolates durable keys and logout clears only verified account', async () => {
    api.state.trustedBrowserEnabled = true;
    const { page, recovery } = await setup({ 'rsrs.dashboard.accounts': JSON.stringify([
      { user: FIXTURE.user, token: FIXTURE.userToken }, { user: FIXTURE.secondUser, token: FIXTURE.secondToken },
    ]) });
    await (await enroll(page, recovery, 'Account A', true)).waitFor({ state: 'hidden' });
    await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(FIXTURE.secondToken);
    await page.waitForFunction(token => localStorage.getItem('rsrs.userToken') === token, FIXTURE.secondToken);
    await nav(page, 'keys');
    await page.getByRole('button', { name: t('passkeyBind'), exact: true }).and(page.locator(':enabled')).waitFor();
    assert.equal(await page.locator('.passkey-list li').count(), 0);
    await (await enroll(page, recovery, 'Account B', true)).waitFor({ state: 'hidden' });
    const records = await waitLocalCount(page, 2);
    assert.deepEqual(records.map(r => r.account_id).sort(), ['fixture-account-id', 'fixture-second-account-id']);
    await page.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
    await page.locator('.gate-form').waitFor();
    const remaining = await waitLocalCount(page, 1); assert.equal(remaining[0].account_id, 'fixture-account-id');
  });

  await run('trusted browser: a reloaded passive sessions tab cannot expand account A logout to account B', async () => {
    api.state.trustedBrowserEnabled = true;
    const { page, recovery } = await setup({ 'rsrs.dashboard.accounts': JSON.stringify([
      { user: FIXTURE.user, token: FIXTURE.userToken }, { user: FIXTURE.secondUser, token: FIXTURE.secondToken },
    ]) });
    await (await enroll(page, recovery, 'Account A across tabs', true)).waitFor({ state: 'hidden' });
    await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(FIXTURE.secondToken);
    await page.waitForFunction(token => localStorage.getItem('rsrs.userToken') === token, FIXTURE.secondToken);
    await nav(page, 'keys');
    await page.getByRole('button', { name: t('passkeyBind'), exact: true }).and(page.locator(':enabled')).waitFor();
    await (await enroll(page, recovery, 'Account B across tabs', true)).waitFor({ state: 'hidden' });
    await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(FIXTURE.userToken);
    await page.waitForFunction(token => localStorage.getItem('rsrs.userToken') === token, FIXTURE.userToken);
    await nav(page, 'keys'); await page.reload();
    await page.getByRole('button', { name: t('passkeyBind'), exact: true }).and(page.locator(':enabled')).waitFor();
    assert.equal((await waitLocalCount(page, 2)).length, 2);

    const passive = await page.context().newPage(), passiveErrors = [];
    passive.setDefaultTimeout(10000);
    passive.on('pageerror', error => passiveErrors.push(error.message));
    await passive.goto(new URL('/dashboard#/sessions', page.url()).href);
    await passive.reload(); // The sessions route never looks up the stable account UUID.
    await passive.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).waitFor();
    await page.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
    await page.locator('.gate-form').waitFor(); await passive.locator('.gate-form').waitFor();
    const remaining = await waitLocalCount(page, 1);
    assert.equal(remaining[0].account_id, 'fixture-second-account-id');
    assert.deepEqual(await localTrustedRecords(passive), remaining);
    assert.equal(await passive.getByRole('status').filter({ hasText: t('trustedLogoutAll') }).count(), 0);
    assert.deepEqual(passiveErrors, []);
  });

  await run('trusted browser: default-off logout with no trusted keys is quiet but commits its durable fence', async () => {
    assert.equal(api.state.trustedBrowserEnabled, false);
    const page = await open('/dashboard/sessions', { 'rsrs.userToken': FIXTURE.userToken });
    await page.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).waitFor();
    await page.evaluate(() => {
      window.trustedCleanupCommits = 0;
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = original.apply(this, args);
        if (this.name === 'respire-trusted-browser-v1' && args[1] === 'readwrite') {
          tx.addEventListener('complete', () => { window.trustedCleanupCommits++; });
        }
        return tx;
      };
    });
    await page.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
    await page.locator('.gate-form').waitFor();
    await page.waitForFunction(() => window.trustedCleanupCommits > 0);
    assert.equal(await page.getByRole('status').filter({ hasText: t('trustedLogoutAll') }).count(), 0);
    assert.equal(await page.getByRole('status').filter({ hasText: t('trustedCleanupFailed') }).count(), 0);
    assert.deepEqual(await localTrustedRecords(page), []);
  });

  await run('trusted browser: a nonempty account switch resolves the new UUID instead of transferring the old one', async () => {
    api.state.trustedBrowserEnabled = true;
    const { page, recovery } = await setup({ 'rsrs.dashboard.accounts': JSON.stringify([
      { user: FIXTURE.user, token: FIXTURE.userToken }, { user: FIXTURE.secondUser, token: FIXTURE.secondToken },
    ]) });
    await (await enroll(page, recovery, 'Account A before remote switch', true)).waitFor({ state: 'hidden' });
    await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(FIXTURE.secondToken);
    await page.waitForFunction(token => localStorage.getItem('rsrs.userToken') === token, FIXTURE.secondToken);
    await nav(page, 'keys');
    await page.getByRole('button', { name: t('passkeyBind'), exact: true }).and(page.locator(':enabled')).waitFor();
    await (await enroll(page, recovery, 'Account B before remote switch', true)).waitFor({ state: 'hidden' });
    await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(FIXTURE.userToken);
    await page.waitForFunction(token => localStorage.getItem('rsrs.userToken') === token, FIXTURE.userToken);

    const passive = await page.context().newPage(), passiveErrors = [];
    passive.setDefaultTimeout(10000);
    passive.on('pageerror', error => passiveErrors.push(error.message));
    await passive.goto(new URL('/dashboard#/keys', page.url()).href);
    await passive.getByRole('button', { name: t('passkeyBind'), exact: true }).and(passive.locator(':enabled')).waitFor();
    await nav(passive, 'sessions'); // This tab knows A's UUID, but has never learned B's.
    await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(FIXTURE.secondToken);
    await passive.locator('.workspace-switch strong').filter({ hasText: FIXTURE.secondUser }).waitFor();
    assert.equal((await localTrustedRecords(passive)).length, 2);
    await passive.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
    await passive.locator('.gate-form').waitFor(); await page.locator('.gate-form').waitFor();
    // The new token's authoritative UUID selects B; neither an inferred A nor
    // an unnecessary all-account fallback may delete A's independent trust.
    const remaining = await waitLocalCount(passive, 1);
    assert.equal(remaining[0].account_id, 'fixture-account-id');
    assert.equal(await passive.getByRole('status').filter({ hasText: t('trustedLogoutAll') }).count(), 0);
    assert.deepEqual(passiveErrors, []);
  });

  await run('trusted browser: remote same-account rotation resolves UUID before logout and preserves account B', async () => {
    const { page } = await twoTrustedAccounts();
    const { passive, errors } = await receivingSessionsTab(page);
    const identified = passive.waitForResponse(r => new URL(r.url()).pathname === '/api/self/vault'
      && r.request().headers().authorization === 'Bearer fixture-rotated-token');
    await page.getByRole('button', { name: t('rotateToken'), exact: true }).click();
    assert.equal((await identified).status(), 200);
    await passive.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
    await passive.locator('.gate-form').waitFor(); await page.locator('.gate-form').waitFor();
    const remaining = await waitLocalCount(passive, 1);
    assert.equal(remaining[0].account_id, 'fixture-second-account-id');
    assert.equal(await passive.getByRole('status').filter({ hasText: t('trustedLogoutAll') }).count(), 0);
    assert.deepEqual(errors, []);
  });

  await run('trusted browser: failed remote identity lookup retains warned conservative logout', async () => {
    const { page } = await twoTrustedAccounts();
    const { passive, errors } = await receivingSessionsTab(page);
    api.state.vaultFailures.set(FIXTURE.secondToken, { status: 503, error: 'Synthetic optional identity failure' });
    await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(FIXTURE.secondToken);
    await passive.locator('.workspace-switch strong').filter({ hasText: FIXTURE.secondUser }).waitFor();
    await passive.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
    await passive.locator('.gate-form').waitFor();
    await passive.getByRole('status').filter({ hasText: t('trustedLogoutAll') }).waitFor();
    await waitLocalCount(passive, 0);
    assert.deepEqual(errors, []);
  });

  for (const interruption of ['switch', 'logout', 'same-token-reentry']) await run(`trusted browser: late identity reply cannot override ${interruption}`, async () => {
    const { page } = await twoTrustedAccounts();
    const { passive, errors } = await receivingSessionsTab(page);
    let release, started;
    api.state.vaultGates.set(FIXTURE.secondToken, new Promise(resolve => { release = resolve; }));
    const requested = new Promise(resolve => { started = resolve; });
    api.state.vaultStarted.set(FIXTURE.secondToken, started);
    if (interruption === 'same-token-reentry') api.state.vaultFailures.set(FIXTURE.secondToken, { status: 401, error: 'Synthetic stale identity response' });
    try {
      await page.evaluate(token => localStorage.setItem('rsrs.userToken', token), FIXTURE.secondToken);
      await requested;
      await passive.getByText(t('checkingLogin'), { exact: true }).waitFor();
      assert.equal(await passive.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).count(), 0);
      api.state.vaultGates.delete(FIXTURE.secondToken); api.state.vaultFailures.delete(FIXTURE.secondToken);
      api.state.vaultStarted.delete(FIXTURE.secondToken);
      if (interruption === 'logout') {
        await page.evaluate(() => localStorage.setItem('rsrs.userToken', ''));
        await passive.locator('.gate-form').waitFor();
      } else if (interruption === 'same-token-reentry') {
        const fresh = passive.waitForResponse(r => new URL(r.url()).pathname === '/api/self/vault'
          && r.request().headers().authorization === `Bearer ${FIXTURE.secondToken}` && r.status() === 200);
        await page.evaluate(token => { localStorage.setItem('rsrs.userToken', ''); localStorage.setItem('rsrs.userToken', token); }, FIXTURE.secondToken);
        await fresh;
        await passive.locator('.workspace-switch strong').filter({ hasText: FIXTURE.secondUser }).waitFor();
      } else {
        await page.evaluate(token => localStorage.setItem('rsrs.userToken', token), FIXTURE.userToken);
        await passive.locator('.workspace-switch strong').filter({ hasText: FIXTURE.user }).waitFor();
      }
    } finally { release(); api.state.vaultGates.clear(); api.state.vaultFailures.clear(); api.state.vaultStarted.clear(); }
    await passive.waitForLoadState('networkidle');
    if (interruption === 'logout') await passive.locator('.gate-form').waitFor();
    else {
      const expected = interruption === 'switch' ? FIXTURE.user : FIXTURE.secondUser;
      await passive.locator('.workspace-switch strong').filter({ hasText: expected }).waitFor();
      await passive.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
      await passive.locator('.gate-form').waitFor();
      const remaining = await waitLocalCount(passive, 1);
      assert.equal(remaining[0].account_id, interruption === 'switch' ? 'fixture-second-account-id' : 'fixture-account-id');
    }
    assert.deepEqual(errors, []);
  });

  await run('identity probe: dismissing a GitHub callback restarts a delayed same-token login check', async () => {
    let release;
    api.state.selfGates.set(FIXTURE.userToken, new Promise(resolve => { release = resolve; }));
    const page = await open('/dashboard?state=synthetic-cancelled-grant&error=access_denied', { 'rsrs.userToken': FIXTURE.userToken });
    try {
      const restarted = page.waitForRequest(r => new URL(r.url()).pathname === '/api/self' && r.method() === 'GET');
      await page.getByRole('button', { name: t('backToLogin'), exact: true }).click();
      await restarted;
    } finally { api.state.selfGates.delete(FIXTURE.userToken); release(); }
    await page.locator('.workspace-switch strong').filter({ hasText: FIXTURE.user }).waitFor();
    assert.equal(await page.getByText(t('checkingLogin'), { exact: true }).count(), 0);
  });

  await run('identity probe: an expired old token cannot cancel entry to a valid different account', async () => {
    const page = await open('/dashboard/sessions', { 'rsrs.userToken': FIXTURE.userToken,
      'rsrs.dashboard.accounts': JSON.stringify([
        { user: FIXTURE.user, token: FIXTURE.userToken }, { user: FIXTURE.secondUser, token: FIXTURE.secondToken },
      ]) });
    await page.locator('.workspace-switch strong').filter({ hasText: FIXTURE.user }).waitFor();
    await page.waitForLoadState('networkidle');
    const start = api.requests.length;
    api.state.rotatedToken = 'fixture-expired-account-a-token';
    await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(FIXTURE.secondToken);
    await page.locator('.workspace-switch strong').filter({ hasText: FIXTURE.secondUser }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('rsrs.userToken')), FIXTURE.secondToken);
    assert.equal(api.requests.slice(start).filter(r => r.method === 'GET' && r.path === '/api/self'
      && r.headers.authorization === `Bearer ${FIXTURE.userToken}`).length, 0);
  });

  await run('trusted browser: a delayed known-account logout event cannot delete a newer enrollment', async () => {
    api.state.trustedBrowserEnabled = true;
    const { page, recovery } = await setup();
    await (await enroll(page, recovery, 'Before delayed logout', true)).waitFor({ state: 'hidden' });
    const passive = await page.context().newPage(), passiveErrors = [];
    passive.setDefaultTimeout(10000);
    passive.on('pageerror', error => passiveErrors.push(error.message));
    await passive.goto(new URL('/dashboard#/keys', page.url()).href);
    await passive.getByRole('button', { name: t('passkeyBind'), exact: true }).and(passive.locator(':enabled')).waitFor();
    await passive.evaluate(() => {
      window.delayedLogoutEvents = [];
      window.holdLogoutEvents = true;
      window.addEventListener('storage', event => {
        if (window.holdLogoutEvents && event.key === 'rsrs.userToken' && !event.newValue && event.oldValue) {
          event.stopImmediatePropagation();
          window.delayedLogoutEvents.push({ key: event.key, oldValue: event.oldValue, newValue: event.newValue, url: event.url, storageArea: event.storageArea });
        }
      }, true);
    });
    await page.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
    await page.locator('.gate-form').waitFor(); await waitLocalCount(page, 0);
    await passive.waitForFunction(() => window.delayedLogoutEvents.length === 1);
    await page.getByLabel(t('username'), { exact: true }).fill(FIXTURE.user);
    await page.getByLabel(t('loginPassword'), { exact: true }).fill(FIXTURE.password);
    await page.locator('.gate-form form').getByRole('button', { name: t('login'), exact: true }).click();
    await page.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).waitFor();
    await nav(page, 'keys');
    await page.getByRole('button', { name: t('passkeyBind'), exact: true }).and(page.locator(':enabled')).waitFor();
    await (await enroll(page, recovery, 'After delayed logout', true)).waitFor({ state: 'hidden' });
    const replacement = await waitLocalCount(page, 1);
    const cleanupWrites = await passive.evaluate(async () => {
      const pending = new Set(), cleanupWrites = [];
      const transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (this.name === 'respire-trusted-browser-v1') {
          let done;
          const settled = new Promise(resolve => { done = resolve; });
          pending.add(settled);
          const finish = () => { pending.delete(settled); done(); };
          tx.addEventListener('complete', finish, { once: true });
          tx.addEventListener('abort', finish, { once: true });
        }
        return tx;
      };
      IDBObjectStore.prototype.put = function (value, ...rest) {
        if (this.name === 'epochs' && (value.id === 'global' || value.id.startsWith('account:'))) cleanupWrites.push(value.id);
        return put.call(this, value, ...rest);
      };
      window.holdLogoutEvents = false;
      for (const event of window.delayedLogoutEvents.splice(0)) window.dispatchEvent(new StorageEvent('storage', event));
      // The receiving tab already opened this DB. Drain the handler's promise
      // continuations and every native transaction it starts, including writes
      // scheduled by a preceding transaction's completion. No arbitrary sleep.
      const nextTask = () => new Promise(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
        channel.port2.postMessage(null);
      });
      do { await Promise.all([...pending]); await nextTask(); } while (pending.size);
      return cleanupWrites;
    });
    assert.deepEqual(cleanupWrites, [], 'A passive event must not even schedule another durable logout fence');
    assert.deepEqual(await localTrustedRecords(passive), replacement);
    assert.deepEqual(await localTrustedRecords(page), replacement);
    assert.deepEqual(passiveErrors, []);
  });

  await run('trusted browser: revoke locks the accepted session and navigation cannot skip acknowledged local cleanup', async () => {
    api.state.trustedBrowserEnabled = true;
    const { page, recovery } = await setup();
    await (await enroll(page, recovery, 'Revoked trusted browser', true)).waitFor({ state: 'hidden' });
    await nav(page, 'memories');
    await page.getByRole('button', { name: t('passkeyUnlock'), exact: true }).and(page.locator(':enabled')).click();
    await page.locator('.empty-guide').waitFor();
    await nav(page, 'keys');
    let release, started;
    api.state.passkeyRemoveGate = new Promise(resolve => { release = resolve; });
    const dispatched = new Promise(resolve => { started = resolve; });
    api.state.passkeyRemoveStarted = started;
    try {
      await page.locator('.passkey-list li').getByRole('button', { name: t('passkeyRemove'), exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: t('passkeyRemove'), exact: true }).click();
      await dispatched;
      await page.evaluate(() => { location.hash = '/memories'; });
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.locator('.locked-state').waitFor();
      assert.equal(await page.locator('.empty-guide').count(), 0);
    } finally { release(); api.state.passkeyRemoveGate = null; }
    await waitLocalCount(page, 0); assert.equal(api.state.passkeys.size, 0);
  });

  await run('trusted browser: unknown logout identity clears local trust with a visible fallback warning', async () => {
    api.state.trustedBrowserEnabled = true;
    const { page, recovery } = await setup();
    await (await enroll(page, recovery, 'Forgotten identity', true)).waitFor({ state: 'hidden' });
    await nav(page, 'sessions');
    await page.reload(); // No Passkeys component or authenticated UUID lookup on this route.
    await page.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
    await page.locator('.gate-form').waitFor();
    await page.getByRole('status').filter({ hasText: t('trustedLogoutAll') }).waitFor();
    await waitLocalCount(page, 0);
  });

  await run('trusted browser: failed local cleanup never prevents logout and remains visible', async () => {
    api.state.trustedBrowserEnabled = true;
    const { page, recovery } = await setup();
    await (await enroll(page, recovery, 'Cleanup failure', true)).waitFor({ state: 'hidden' });
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function (...args) {
        if (this.name === 'keys') throw new DOMException('Synthetic deletion denied', 'UnknownError');
        return original.apply(this, args);
      };
    });
    await page.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
    await page.locator('.gate-form').waitFor();
    await page.getByRole('status').filter({ hasText: t('trustedCleanupFailed') }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('rsrs.userToken')), '');
    await waitLocalCount(page, 1);
  });

  for (const cleanupFails of [false, true]) await run(`trusted browser: destructive reset invalidates trust and delivers recovery with cleanup failure=${cleanupFails}`, async () => {
    api.state.trustedBrowserEnabled = true;
    const { page, recovery } = await setup();
    await (await enroll(page, recovery, 'Before destructive reset', true)).waitFor({ state: 'hidden' });
    if (cleanupFails) await page.evaluate(() => {
      const original = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function (...args) {
        if (this.name === 'keys') throw new DOMException('Synthetic deletion denied', 'UnknownError');
        return original.apply(this, args);
      };
    });
    await page.locator('.setting-row').filter({ has: page.getByRole('heading', { name: t('resetKeysH3'), exact: true }) })
      .getByRole('button', { name: t('reset'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(t('typeConfirmReset'), { exact: true }).fill(t('confirmResetWord'));
    await dialog.getByRole('button', { name: t('confirmResetAbandon'), exact: true }).click();
    await page.getByRole('dialog').getByRole('heading', { name: t('copySuperNowTitle'), exact: true }).waitFor();
    const replacement = await page.getByRole('dialog').locator('.secret-result code').textContent();
    assert.notEqual(replacement, recovery);
    assert.equal((await unwrapUrk(replacement, undefined, api.state.vault)).length, 32);
    assert.equal(api.state.keyGeneration, 2); assert.equal(api.state.passkeys.size, 0);
    if (cleanupFails) await page.getByRole('dialog').getByText(t('trustedResetCleanupFailed'), { exact: true }).waitFor();
    else await waitLocalCount(page, 0);
  });

  await run('trusted browser: token rotation preserves stable local identity and native unlock', async () => {
    api.state.trustedBrowserEnabled = true;
    const { page, recovery } = await setup();
    await (await enroll(page, recovery, 'Rotated account', true)).waitFor({ state: 'hidden' });
    const before = await localTrustedRecords(page);
    await nav(page, 'sessions');
    await page.getByRole('button', { name: t('rotateToken'), exact: true }).click();
    await page.waitForFunction(() => localStorage.getItem('rsrs.userToken') === 'fixture-rotated-token');
    await nav(page, 'memories');
    await page.getByRole('button', { name: t('passkeyUnlock'), exact: true }).and(page.locator(':enabled')).click();
    await page.locator('.empty-guide').waitFor();
    assert.deepEqual(await localTrustedRecords(page), before);
    await page.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
    await page.locator('.gate-form').waitFor(); await waitLocalCount(page, 0);
  });

  await run('trusted browser: local-key deletion during first memory pull cannot deliver an unlock', async () => {
    api.state.trustedBrowserEnabled = true;
    const { page, recovery } = await setup();
    await (await enroll(page, recovery, 'Delayed memory acceptance', true)).waitFor({ state: 'hidden' });
    let release;
    api.state.memoriesGate = new Promise(resolve => { release = resolve; });
    try {
      await nav(page, 'memories');
      const pull = page.waitForRequest(r => new URL(r.url()).pathname === '/api/self/memories');
      await page.getByRole('button', { name: t('passkeyUnlock'), exact: true }).and(page.locator(':enabled')).click();
      await pull;
      await localTrustedRecords(page, true); // Independent real IndexedDB connection.
    } finally { release(); api.state.memoriesGate = null; }
    await page.waitForLoadState('networkidle');
    await page.locator('.locked-state').waitFor();
    assert.equal(await page.locator('.empty-guide').count(), 0);
  });

  await run('passkeys: two verified gets, multiple bindings, reload unlock, removal and recovery', async () => {
    const { recovery, page, requests } = await setup();
    const original = structuredClone(api.state.vault);
    await (await enroll(page, recovery)).waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.passkeyFixture.gets), 2);
    assert.equal(api.state.passkeys.size, 1);
    await (await enroll(page, recovery, 'Second synthetic passkey')).waitFor({ state: 'hidden' });
    assert.equal(api.state.passkeys.size, 2);
    assert.deepEqual(api.state.vault, original, 'Binding must never replace recovery wrapper or root key');
    await nav(page, 'memories');
    await page.locator('.locked-state').waitFor();
    await page.getByRole('button', { name: t('passkeyUnlock'), exact: true }).click();
    await page.locator('.empty-guide').waitFor();
    await page.reload();
    await page.locator('.locked-state').waitFor();
    await syntheticProvider(page);
    await page.getByRole('button', { name: t('passkeyUnlock'), exact: true }).click();
    await page.locator('.empty-guide').waitFor();
    await nav(page, 'keys');
    await page.locator('.passkey-list li').first().getByRole('button', { name: t('passkeyRemove'), exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: t('passkeyRemove'), exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(api.state.passkeys.size, 1);
    assert.deepEqual(api.state.vault, original);
    assert.equal((await unwrapUrk(recovery, undefined, api.state.vault)).length, 32);
    await noRecoveryStorage(page, recovery);
    const sent = JSON.stringify(requests().filter(r => r.path.startsWith('/api/self/passkeys')).map(r => r.body));
    assert.ok(!sent.includes(recovery));
    assert.ok(!sent.includes('results'));
  });

  for (const [mode, code, gets, stages] of [
    ['unsupported', 'passkeyPrfCreateUnavailable', 0, ['/register/start']],
    ['missingSecond', 'passkeyPrfReopenMissing', 2, ['/register/start', '/register/finish', '/register/test']],
  ]) await run(`passkeys: ${mode} identifies the PRF stage without activation`, async () => {
    const { recovery, page, requests } = await setup();
    const original = structuredClone(api.state.vault);
    await page.evaluate(mode => { window.passkeyFixture.mode = mode; }, mode);
    const dialog = await enroll(page, recovery, 'Synthetic provider capability');
    await dialog.getByRole('alert').filter({ hasText: t(code) }).waitFor();
    assert.equal(await dialog.getByRole('alert').textContent(), t(code));
    assert.equal(await page.evaluate(() => window.passkeyFixture.gets), gets);
    assert.deepEqual(requests().filter(r => r.method === 'POST' && r.path.startsWith('/api/self/passkeys'))
      .map(r => r.path.slice('/api/self/passkeys'.length)), stages);
    assert.equal(api.state.passkeys.size, 0);
    assert.deepEqual(api.state.vault, original);
    assert.equal((await unwrapUrk(recovery, undefined, api.state.vault)).length, 32);
    await noRecoveryStorage(page, recovery);
    await dialog.getByRole('button', { name: t('cancel'), exact: true }).click();
  });

  await run('passkeys: missing PRF fails closed, cancellation retries, late modal result cannot commit', async () => {
    const { recovery, page, requests } = await setup();
    await page.evaluate(() => { window.passkeyFixture.mode = 'missing'; });
    const dialog = await enroll(page, recovery, 'Unsupported');
    await dialog.getByRole('alert').filter({ hasText: t('passkeyPrfFirstMissing') }).waitFor();
    assert.equal(await dialog.getByRole('alert').textContent(), t('passkeyPrfFirstMissing'));
    assert.deepEqual(requests().filter(r => r.method === 'POST' && r.path.startsWith('/api/self/passkeys'))
      .map(r => r.path.slice('/api/self/passkeys'.length)), ['/register/start', '/register/finish']);
    assert.equal(api.state.passkeys.size, 0);
    await dialog.getByRole('button', { name: t('cancel'), exact: true }).click();
    await page.evaluate(() => { window.passkeyFixture.mode = 'delay'; });
    const pending = await enroll(page, recovery, 'Cancelled binding');
    await page.waitForFunction(() => !!window.passkeyFixture.resolve);
    await pending.getByRole('button', { name: t('cancel'), exact: true }).click();
    await page.evaluate(() => { window.passkeyFixture.resolve(); window.passkeyFixture.mode = 'normal'; });
    await (await enroll(page, recovery, 'Retry')).waitFor({ state: 'hidden' });
    assert.equal(api.state.passkeys.size, 1);
    assert.equal([...api.state.passkeys.values()][0].label, 'Retry');
    await noRecoveryStorage(page, recovery);
  });

  await run('passkeys: unlock missing PRF reports unchanged existing binding', async () => {
    const { recovery, page, requests } = await setup();
    await (await enroll(page, recovery, 'Synthetic existing binding')).waitFor({ state: 'hidden' });
    const binding = structuredClone([...api.state.passkeys.values()][0]);
    await nav(page, 'memories');
    await page.locator('.locked-state').waitFor();
    await page.evaluate(() => { window.passkeyFixture.mode = 'missing'; });
    await page.getByRole('button', { name: t('passkeyUnlock'), exact: true }).click();
    await page.getByRole('alert').filter({ hasText: t('passkeyPrfUnlockMissing') }).waitFor();
    assert.equal(await page.getByRole('alert').textContent(), t('passkeyPrfUnlockMissing'));
    assert.deepEqual([...api.state.passkeys.values()], [binding]);
    assert.equal(requests().filter(r => r.method === 'POST' && r.path === '/api/self/passkeys/unlock/finish').length, 0);
    await page.locator('.locked-state').waitFor();
    await noRecoveryStorage(page, recovery);
  });

  for (const interruption of ['cancel', 'navigate', 'competing recovery']) await run(`passkeys: ${interruption} before first memory batch fences stale unlock`, async () => {
    const { recovery, page, requests } = await setup();
    await (await enroll(page, recovery, 'Synthetic')).waitFor({ state: 'hidden' });
    await nav(page, 'memories');
    let release;
    api.state.memoriesGate = new Promise(resolve => { release = resolve; });
    const requested = page.waitForRequest(r => new URL(r.url()).pathname === '/api/self/memories');
    try {
      await page.getByRole('button', { name: t('passkeyUnlock'), exact: true }).click();
      await requested;
      if (interruption === 'cancel') await page.locator('.passkey-unlock').getByRole('button', { name: t('cancel'), exact: true }).click();
      if (interruption === 'navigate') await nav(page, 'security');
      if (interruption === 'competing recovery') {
        await page.getByRole('button', { name: t('unlockMemory'), exact: true }).click();
        await page.getByRole('dialog').getByLabel(t('labelSuperA3'), { exact: true }).fill(recovery);
        await page.getByRole('dialog').getByRole('button', { name: t('unlockView'), exact: true }).click();
      }
    } finally { release(); api.state.memoriesGate = null; }
    if (interruption === 'navigate') await nav(page, 'memories');
    if (interruption === 'competing recovery') {
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.locator('.empty-guide').waitFor();
    } else {
      await page.locator('.locked-state').waitFor();
      await page.getByRole('button', { name: t('passkeyUnlock'), exact: true }).click();
      await page.locator('.empty-guide').waitFor();
    }
    await noRecoveryStorage(page, recovery);
  });

  await run('passkeys: navigation dismisses pending binding and fences a late provider response', async () => {
    const { recovery, page, requests } = await setup();
    await page.evaluate(() => { window.passkeyFixture.mode = 'delay'; });
    await enroll(page, recovery, 'Abandoned');
    await page.waitForFunction(() => !!window.passkeyFixture.resolve);
    await page.evaluate(() => { location.hash = '/security'; });
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.evaluate(() => { window.passkeyFixture.resolve(); window.passkeyFixture.mode = 'normal'; });
    await nav(page, 'keys');
    await (await enroll(page, recovery, 'New attempt')).waitFor({ state: 'hidden' });
    assert.equal(api.state.passkeys.size, 1);
    assert.equal([...api.state.passkeys.values()][0].label, 'New attempt');
  });

  await run('passkeys: accepted commit with failed confirmation refreshes list without retry or removal', async () => {
    const { recovery, page, requests } = await setup();
    const original = structuredClone(api.state.vault);
    api.state.passkeyCommitResponseLost = true;
    await (await enroll(page, recovery, 'Lost confirmation')).waitFor({ state: 'hidden' });
    await page.locator('.passkey-list').getByText('Lost confirmation', { exact: true }).waitFor();
    await page.getByText(t('passkeyCommitFound'), { exact: true }).waitFor();
    assert.equal(api.state.passkeys.size, 1);
    assert.equal(requests().filter(r => r.method === 'POST' && r.path.endsWith('/register/commit')).length, 1);
    assert.equal(requests().filter(r => r.path.endsWith('/remove')).length, 0);
    assert.deepEqual(api.state.vault, original);
    await noRecoveryStorage(page, recovery);
    await page.locator('.passkey-list').getByRole('button', { name: t('passkeyRemove'), exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: t('passkeyRemove'), exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.getByText(t('passkeyCommitFound'), { exact: true }).count(), 0);
  });

  await run('passkeys: cancel after server commit refreshes binding and never reopens the dialog', async () => {
    const { recovery, page, requests } = await setup();
    let release, stored;
    api.state.passkeyCommitResponseGate = new Promise(resolve => { release = resolve; });
    const accepted = new Promise(resolve => { stored = resolve; });
    api.state.passkeyCommitStored = stored;
    try {
      const dialog = await enroll(page, recovery, 'Accepted before cancel');
      await accepted;
      await dialog.getByRole('button', { name: t('cancel'), exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.locator('.passkey-list').getByText('Accepted before cancel', { exact: true }).waitFor();
      await page.getByText(t('passkeyCommitFound'), { exact: true }).waitFor();
    } finally { release(); api.state.passkeyCommitResponseGate = null; }
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(api.state.passkeys.size, 1);
    assert.equal(requests().filter(r => r.path.endsWith('/remove')).length, 0);
  });

  for (const interruption of ['cancel', 'navigate']) await run(`passkeys: ${interruption} after dispatch preserves uncertainty when refresh precedes commit`, async () => {
    const { recovery, page, requests } = await setup();
    let release, started, stored;
    api.state.passkeyCommitGate = new Promise(resolve => { release = resolve; });
    const dispatched = new Promise(resolve => { started = resolve; });
    const accepted = new Promise(resolve => { stored = resolve; });
    api.state.passkeyCommitStarted = started;
    api.state.passkeyCommitStored = stored;
    try {
      const dialog = await enroll(page, recovery, 'In-flight commit');
      await dispatched;
      if (interruption === 'cancel') await dialog.getByRole('button', { name: t('cancel'), exact: true }).click();
      else await page.evaluate(() => { location.hash = '/security'; });
      await dialog.waitFor({ state: 'hidden' });
      if (interruption === 'navigate') await nav(page, 'keys');
      await page.locator('.key-panel .note').getByText(t('passkeyCommitUnknown'), { exact: true }).waitFor();
      assert.equal(api.state.passkeys.size, 0, 'The first authoritative list precedes the in-flight write');
      assert.equal(await page.getByRole('button', { name: t('passkeyBind'), exact: true }).isDisabled(), true);
    } finally { release(); api.state.passkeyCommitGate = null; }
    await accepted;
    await page.getByRole('button', { name: t('passkeyRefresh'), exact: true }).click();
    await page.locator('.passkey-list').getByText('In-flight commit', { exact: true }).waitFor();
    await page.getByText(t('passkeyCommitFound'), { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(requests().filter(r => r.path.endsWith('/remove')).length, 0);
    assert.equal(requests().filter(r => r.method === 'POST' && r.path.endsWith('/register/commit')).length, 1);
    await noRecoveryStorage(page, recovery);
  });

  await run('passkeys: acknowledged retry refreshes first and preserves possibly successful credentials', async () => {
    const { recovery, page, requests } = await setup();
    api.state.passkeyCommitRejected = true;
    await (await enroll(page, recovery, 'Unconfirmed first attempt')).waitFor({ state: 'hidden' });
    await page.locator('.key-panel .note').getByText(t('passkeyCommitUnknown'), { exact: true }).waitFor();
    await page.getByRole('button', { name: t('passkeyRetryUnknown'), exact: true }).click();
    api.state.passkeyCommitRejected = false;
    await page.getByRole('dialog').getByRole('button', { name: t('passkeyRetryConfirm'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(t('labelSuperA3'), { exact: true }).fill(recovery);
    await dialog.getByLabel(t('passkeyLabel'), { exact: true }).fill('Acknowledged retry');
    await dialog.getByRole('button', { name: t('passkeyBind'), exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.locator('.passkey-list').getByText('Acknowledged retry', { exact: true }).waitFor();
    assert.equal(requests().filter(r => r.path.endsWith('/remove')).length, 0);
    assert.equal(requests().filter(r => r.method === 'POST' && r.path.endsWith('/register/commit')).length, 2);
  });

  await run('passkeys: cancelling a delayed retry refresh never reopens enrollment', async () => {
    const { recovery, page, requests } = await setup();
    api.state.passkeyCommitRejected = true;
    await (await enroll(page, recovery, 'Unconfirmed')).waitFor({ state: 'hidden' });
    await page.locator('.key-panel .note').getByText(t('passkeyCommitUnknown'), { exact: true }).waitFor();
    await page.getByRole('button', { name: t('passkeyRetryUnknown'), exact: true }).click();
    let release, started;
    api.state.passkeyListGate = new Promise(resolve => { release = resolve; });
    const refreshing = new Promise(resolve => { started = resolve; });
    api.state.passkeyListStarted = started;
    try {
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: t('passkeyRetryConfirm'), exact: true }).click();
      await refreshing;
      await dialog.getByRole('button', { name: t('cancel'), exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    } finally { release(); api.state.passkeyListGate = null; }
    await page.waitForLoadState('networkidle');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.evaluate(() => window.passkeyFixture.creates), 1);
    assert.equal(await page.getByRole('button', { name: t('passkeyBind'), exact: true }).isDisabled(), true);
    await page.locator('.key-panel .note').getByText(t('passkeyCommitUnknown'), { exact: true }).waitFor();
  });

  await run('passkeys: authoritative generation change clears an old uncertainty fence', async () => {
    const { recovery, page, requests } = await setup();
    api.state.passkeyCommitRejected = true;
    await (await enroll(page, recovery, 'Old generation')).waitFor({ state: 'hidden' });
    await page.locator('.key-panel .note').getByText(t('passkeyCommitUnknown'), { exact: true }).waitFor();
    api.state.keyGeneration++;
    api.state.vault = await wrapVaultV4(generateSecretKey());
    await page.getByRole('button', { name: t('passkeyRefresh'), exact: true }).click();
    await page.getByText(t('passkeyCommitChanged'), { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: t('passkeyBind'), exact: true }).isDisabled(), false);
    assert.equal(requests().filter(r => r.path.endsWith('/remove')).length, 0);
  });

  await run('passkeys: Memories to Diary cancels a pending native unlock even with matching layout', async () => {
    const { recovery, page, requests } = await setup();
    await (await enroll(page, recovery, 'Route-scoped')).waitFor({ state: 'hidden' });
    await nav(page, 'memories');
    await page.evaluate(() => { window.passkeyFixture.mode = 'delay'; });
    await page.getByRole('button', { name: t('passkeyUnlock'), exact: true }).click();
    await page.waitForFunction(() => !!window.passkeyFixture.resolve);
    await nav(page, 'diary');
    await page.waitForFunction(() => location.hash === '#/diary');
    await page.evaluate(() => { window.passkeyFixture.resolve(); window.passkeyFixture.mode = 'normal'; });
    await page.waitForLoadState('networkidle');
    await page.locator('.locked-state').waitFor();
    const lateFinishes = requests().filter(r => r.path.endsWith('/unlock/finish'));
    assert.equal(lateFinishes.filter(r => r.method === 'POST').length, 0,
      `No late assertion may be submitted after route navigation; observed methods: ${JSON.stringify(lateFinishes.map(r => r.method))}`);
    await page.getByRole('button', { name: t('passkeyUnlock'), exact: true }).click();
    await page.locator('.locked-state').waitFor({ state: 'hidden' });
    assert.equal(requests().filter(r => r.method === 'POST' && r.path.endsWith('/unlock/finish')).length, 1,
      'Only the fresh Diary attempt may submit an assertion');
  });

  await run('passkeys: same-account token rotation preserves an uncertain commit until positive reconciliation', async () => {
    const { recovery, page, requests } = await setup();
    let release, started, stored;
    api.state.passkeyCommitGate = new Promise(resolve => { release = resolve; });
    const dispatched = new Promise(resolve => { started = resolve; });
    const accepted = new Promise(resolve => { stored = resolve; });
    api.state.passkeyCommitStarted = started;
    api.state.passkeyCommitStored = stored;
    try {
      const dialog = await enroll(page, recovery, 'Rotating account');
      await dispatched;
      await dialog.getByRole('button', { name: t('cancel'), exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.locator('.key-panel .note').getByText(t('passkeyCommitUnknown'), { exact: true }).waitFor();
      await nav(page, 'sessions');
      await page.getByRole('button', { name: t('rotateToken'), exact: true }).click();
      await page.waitForFunction(() => localStorage.getItem('rsrs.userToken') === 'fixture-rotated-token');
      await nav(page, 'keys');
      await page.locator('.key-panel .note').getByText(t('passkeyCommitUnknown'), { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: t('passkeyBind'), exact: true }).isDisabled(), true);
      assert.equal(api.state.passkeys.size, 0);
    } finally { release(); api.state.passkeyCommitGate = null; }
    await accepted;
    await page.getByRole('button', { name: t('passkeyRefresh'), exact: true }).click();
    await page.locator('.passkey-list').getByText('Rotating account', { exact: true }).waitFor();
    await page.getByText(t('passkeyCommitFound'), { exact: true }).waitFor();
    assert.ok(requests().some(r => r.method === 'GET' && r.path === '/api/self/passkeys'
      && r.headers.authorization === 'Bearer fixture-rotated-token'));
    assert.equal(requests().filter(r => r.method === 'POST' && r.path.endsWith('/register/commit')).length, 1);
    assert.equal(requests().filter(r => r.path.endsWith('/remove')).length, 0);
    await noRecoveryStorage(page, recovery);
  });

  await run('passkeys: ordinary account switching never transfers another account pending outcome', async () => {
    const { recovery, page } = await setup({ 'rsrs.dashboard.accounts': JSON.stringify([
      { user: FIXTURE.user, token: FIXTURE.userToken }, { user: FIXTURE.secondUser, token: FIXTURE.secondToken },
    ]) });
    api.state.passkeyCommitRejected = true;
    await (await enroll(page, recovery, 'First account only')).waitFor({ state: 'hidden' });
    await page.locator('.key-panel .note').getByText(t('passkeyCommitUnknown'), { exact: true }).waitFor();
    await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(FIXTURE.secondToken);
    await page.waitForFunction(token => localStorage.getItem('rsrs.userToken') === token, FIXTURE.secondToken);
    await nav(page, 'keys');
    await page.getByRole('button', { name: t('passkeyBind'), exact: true }).and(page.locator(':enabled')).waitFor();
    assert.equal(await page.getByRole('button', { name: t('passkeyBind'), exact: true }).isEnabled(), true);
    assert.equal(await page.locator('.key-panel .note').getByText(t('passkeyCommitUnknown'), { exact: true }).count(), 0);
    await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(FIXTURE.userToken);
    await page.waitForFunction(token => localStorage.getItem('rsrs.userToken') === token, FIXTURE.userToken);
    await nav(page, 'keys');
    await page.locator('.key-panel .note').getByText(t('passkeyCommitUnknown'), { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: t('passkeyBind'), exact: true }).isDisabled(), true);
  });

  await run('passkeys: an accepted memory session disables redundant passkey unlock and keeps syncing', async () => {
    const { recovery, page, requests } = await setup();
    await (await enroll(page, recovery, 'Synthetic')).waitFor({ state: 'hidden' });
    await nav(page, 'memories');
    await page.getByRole('button', { name: t('passkeyUnlock'), exact: true }).click();
    await page.locator('.empty-guide').waitFor();
    await nav(page, 'keys');
    assert.equal(await page.getByRole('button', { name: t('passkeyUnlock'), exact: true }).isDisabled(), true);
    await nav(page, 'memories');
    await page.locator('.empty-guide').waitFor();
    const refreshed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/self/memories');
    await page.getByRole('button', { name: t('pullLatest'), exact: true }).click();
    await refreshed;
    assert.equal(await page.locator('.locked-state').count(), 0);
  });
}
