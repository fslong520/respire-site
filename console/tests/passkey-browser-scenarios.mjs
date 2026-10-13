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
    window.passkeyFixture = { mode: 'normal', creates: 0, gets: 0, ceremonyGets: 0, resolve: null };
    const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const credential = (id, registration) => {
      const result = new Uint8Array(32).fill(91);
      const missing = window.passkeyFixture.mode === 'missing' || (window.passkeyFixture.mode === 'missingSecond' && window.passkeyFixture.ceremonyGets === 2);
      // Provider-shaped outputs: enabled only exists on create. Bitwarden's
      // versioned provider implementation supplies no PRF extension at all.
      const extensions = registration ? (window.passkeyFixture.mode === 'unsupported' ? {} : { prf: { enabled: true } })
        : { prf: missing ? {} : { results: { first: result.buffer } } };
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
async function enroll(page, recovery, label) {
  await page.getByRole('button', { name: t('passkeyBind'), exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(t('labelSuperA3'), { exact: true }).fill(recovery);
  if (label) await dialog.getByLabel(t('passkeyLabel'), { exact: true }).fill(label);
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
    await page.getByText(t('passkeyPrfRequirement'), { exact: true }).waitFor();
    await page.getByText(t('passkeyPrfCompatibility'), { exact: false }).waitFor();
    assert.equal(await page.getByRole('link', { name: t('passkeyPrfSource'), exact: true }).getAttribute('href'),
      'https://github.com/bitwarden/clients/blob/browser-v2026.9.1/apps/browser/src/autofill/fido2/utils/webauthn-utils.ts#L38-L40');
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
