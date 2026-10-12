import assert from 'node:assert/strict';
import { generateSecretKey, wrapVaultV4, unwrapUrk } from '../src/crypto.js';
import { t } from '../src/i18n.js';
import { FIXTURE } from './fixture-api.mjs';

// Deliberately synthetic navigator.credentials implementation. This tests the
// actual built React UI, WebCrypto and HTTP transport, not provider support or
// server WebAuthn signature verification. No credential response is routed/mock-
// fulfilled through Playwright; all API calls reach the loopback fixture server.
async function syntheticProvider(page) {
  await page.evaluate(() => {
    window.passkeyFixture = { mode: 'normal', creates: 0, gets: 0, resolve: null };
    const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const credential = (id, registration) => {
      const result = new Uint8Array(32).fill(91);
      const extensions = { prf: { enabled: true, ...(registration || window.passkeyFixture.mode === 'missing' ? {} : { results: { first: result.buffer } }) } };
      return { id: b64(id), rawId: id, type: 'public-key',
        response: { clientDataJSON: new Uint8Array(16).fill(1), ...(registration
          ? { attestationObject: new Uint8Array(64).fill(2), getTransports: () => ['internal'] }
          : { authenticatorData: new Uint8Array(37).fill(3), signature: new Uint8Array(64).fill(4), userHandle: null }) },
        getClientExtensionResults: () => extensions,
        toJSON() { throw new Error('Unsafe credential serializer called'); } };
    };
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: {
      create: async () => { window.passkeyFixture.creates++; return credential(new Uint8Array(24).fill(window.passkeyFixture.creates), true); },
      get: async ({ publicKey }) => {
        window.passkeyFixture.gets++;
        if (window.passkeyFixture.mode === 'cancel') throw new DOMException('Synthetic cancellation', 'NotAllowedError');
        const value = credential(new Uint8Array(publicKey.allowCredentials[0].id), false);
        if (window.passkeyFixture.mode === 'delay') return new Promise(resolve => { window.passkeyFixture.resolve = () => resolve(value); });
        return value;
      },
    } });
  });
}
async function enroll(page, recovery, label) {
  await page.getByRole('button', { name: t('passkeyBind'), exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(t('labelSuperA3'), { exact: true }).fill(recovery);
  if (label) await dialog.getByLabel(t('passkeyLabel'), { exact: true }).fill(label);
  await dialog.getByRole('button', { name: t('passkeyBind'), exact: true }).click();
  return dialog;
}
const nav = (page, destination) => page.locator(`.sidebar nav a[href="#/${destination}"]`).click();
async function noRecoveryStorage(page, recovery) {
  const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  assert.ok(!storage.includes(recovery));
  assert.ok(!storage.includes('wrapped_urk'));
  assert.ok(!storage.includes('prf_salt'));
}

export async function passkeyBrowserScenarios({ run, open, api }) {
  const setup = async () => {
    api.state.passkeysEnabled = true;
    const recovery = generateSecretKey();
    api.state.vault = await wrapVaultV4(recovery);
    const page = await open('/dashboard/keys', { 'rsrs.userToken': FIXTURE.userToken });
    await syntheticProvider(page);
    await page.getByRole('button', { name: t('passkeyBind'), exact: true }).waitFor();
    return { recovery, page };
  };

  await run('passkeys: two verified gets, multiple bindings, reload unlock, removal and recovery', async () => {
    const { recovery, page } = await setup();
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
    const sent = JSON.stringify(api.requests.filter(r => r.path.startsWith('/api/self/passkeys')).map(r => r.body));
    assert.ok(!sent.includes(recovery));
    assert.ok(!sent.includes('results'));
  });

  await run('passkeys: missing PRF fails closed, cancellation retries, late modal result cannot commit', async () => {
    const { recovery, page } = await setup();
    await page.evaluate(() => { window.passkeyFixture.mode = 'missing'; });
    const dialog = await enroll(page, recovery, 'Unsupported');
    await dialog.getByRole('alert').waitFor();
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

  for (const interruption of ['cancel', 'navigate', 'competing recovery']) await run(`passkeys: ${interruption} before first memory batch fences stale unlock`, async () => {
    const { recovery, page } = await setup();
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
    const { recovery, page } = await setup();
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

  await run('passkeys: an accepted memory session disables redundant passkey unlock and keeps syncing', async () => {
    const { recovery, page } = await setup();
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
