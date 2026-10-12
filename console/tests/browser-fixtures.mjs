import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { decryptItem, deriveDataKeys, unwrapUrk, generateSecretKey, wrapVaultV4 } from '../src/crypto.js';
import { t } from '../src/i18n.js';
import { FIXTURE, startFixtureApi, closeServer, listen } from './fixture-api.mjs';
import { startFixtureProxy } from './fixture-proxy.mjs';

async function assertNoRecoveryStorage(page) {
  const keys = await page.evaluate(() => [localStorage, sessionStorage].flatMap(storage =>
    Object.keys(storage).filter(key => /^(rsrs|onememory)\.(superPass|secretKey|superPassAt)$/.test(key))));
  assert.deepEqual(keys, [], 'No plaintext recovery material may be persisted');
}

// Exercise the compiled single-file bundle against a real loopback service that
// serves the UI separately from the API, mirroring the Pages deployment.
// Both console paths serve the same bundle; JSON requests use the explicit API
// origin and native CORS. All network destinations except these ephemeral servers are
// blocked, and production dist is neither read nor overwritten by this suite.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'respire-console-fixtures-'));
const exec = promisify(execFile);
const USER_KEY = 'rsrs.userToken';
const ADMIN_KEY = 'rsrs.adminToken';
const bothTokens = { [USER_KEY]: FIXTURE.userToken, [ADMIN_KEY]: FIXTURE.adminToken };
const uiPath = (mode) => (mode === 'admin' ? '/admin' : '/dashboard');
const runtimeErrors = [];
const rows = [];
let browser;
let proxy;
let context;
let current = 'build';
let origin;
let frontend;

async function run(name, body) {
  current = name;
  api.reset();
  const before = api.requests.length;
  try {
    await body();
    await Promise.all(context.pages().map(page => page.waitForLoadState('networkidle')));
    assert.deepEqual(api.unexpected, [], 'Fixture API encountered an unexpected request or payload');
    assert.deepEqual(proxy.blocked, [], 'Browser attempted a request outside the fixture transport allowlist');
    assert.deepEqual(proxy.errors, [], 'Fixture proxy encountered a transport failure');
    assert.deepEqual(runtimeErrors, [], 'Browser had an uncaught runtime error');
    rows.push({ name, requests: api.requests.length - before });
    console.log(`PASS ${name}`);
  } finally {
    await context?.close();
    context = undefined;
  }
}

let api;

async function open(path, storage = {}) {
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  // This suite uses neither page/context routes nor direct CDP interception.
  // Playwright's route handler synthesizes responses for routed requests, hiding
  // native transport regressions; direct CDP has a separate hosted-only test suite.
  await context.addCookies([{ name: 'fixture-session-cookie', value: 'must-not-be-sent-to-api', url: api.origin }]);
  await context.addInitScript(({ storage }) => {
    // Do not restore values after reload, logout, or a deliberate auth failure.
    if (!sessionStorage.getItem('fixture-seeded')) {
      for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
      localStorage.setItem('respire.uiLocale', 'en');
      sessionStorage.setItem('fixture-seeded', '1');
    }
  }, { storage });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.goto(`${origin}${path}`);
  return page;
}

async function stored(page, key) {
  return page.evaluate(key => localStorage.getItem(key), key);
}

async function submit(page, label = 'login') {
  await page.locator('.gate-form form').getByRole('button', { name: t(label), exact: true }).click();
}

async function enterCredentials(page, admin = false, password = FIXTURE.password) {
  await page.getByLabel(t('username'), { exact: true }).fill(admin ? FIXTURE.admin : FIXTURE.user);
  await page.getByLabel(t('loginPassword'), { exact: true }).fill(password);
}

async function waitForApi(page, path, method, action, status = 200) {
  const pending = page.waitForResponse(response => response.url().startsWith(api.origin) && new URL(response.url()).pathname === path && response.request().method() === method);
  await action();
  assert.equal((await pending).status(), status, `${method} ${path}`);
}

async function assertAlert(page, message) {
  const alert = page.getByRole('alert');
  await alert.filter({ hasText: message }).waitFor();
  assert.equal(await alert.textContent(), message);
}

async function navigate(page, id) {
  await page.locator(`.console-sidebar nav a[href="#/${id}"]`).click();
  await page.locator(`.console-main.surface-${id}`).waitFor();
}

async function emailTab(page) {
  await page.locator('.console-main.surface-security').waitFor();
  await page.locator('.settings-panel').waitFor();
  await page.locator('.security-tabs').getByRole('button', { name: t('bindEmail'), exact: true }).click();
  await page.getByLabel(t('emailAddress'), { exact: true }).fill(FIXTURE.email);
}

try {
  current = 'fixture proxy unit tests';
  const proxyTests = await exec(process.execPath, ['--test', resolve(root, 'tests/fixture-proxy.test.mjs')], { cwd: root });
  console.log(proxyTests.stdout.trim());
  current = 'build';
  api = await startFixtureApi();
  const outDir = resolve(temporary, 'bundle');
  await exec(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: root,
    env: { ...process.env, VITE_API_BASE_URL: api.origin },
    maxBuffer: 4 * 1024 * 1024,
  });
  const html = await readFile(resolve(outDir, 'index.html'));
  assert.ok(html.length > 10000, 'The compiled bundle is unexpectedly empty');
  const assets = new Map();
  for (const name of (await readdir(outDir)).filter(name => name.endsWith('.woff2'))) {
    assets.set(`/${name}`, await readFile(resolve(outDir, name)));
  }
  frontend = createServer((request, response) => {
      const url = new URL(request.url, 'http://fixture.invalid');
      if (request.method !== 'GET') { response.writeHead(405).end(); return; }
      const path = url.pathname;
      if (path === '/favicon.ico') { response.writeHead(204).end(); return true; }
      const spa = path === '/' || path === '/admin' || path === '/admin/' || path === '/dashboard' || path === '/dashboard/' || path.startsWith('/dashboard/');
      if (spa) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
        return true;
      }
      const font = assets.get(path);
      if (font) { response.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'no-store' }).end(font); return true; }
      response.writeHead(404).end();
  });
  origin = await listen(frontend);
  api.origins.add(origin);
  proxy = await startFixtureProxy([{ origin: api.origin, methods: ['GET', 'POST', 'OPTIONS'] }, { origin, methods: ['GET'] }]);
  current = 'launch browser';
  browser = await chromium.launch({
    headless: true,
    // Chromium otherwise bypasses proxies for loopback hosts. This only changes
    // proxy routing; browser web security remains enabled.
    proxy: { server: proxy.origin, bypass: '<-loopback>' },
    ...(process.env.RSRS_BROWSER_EXECUTABLE ? { executablePath: process.env.RSRS_BROWSER_EXECUTABLE } : {}),
  });

  const accountKey = 'rsrs.dashboard.accounts';
  const savedAccounts = [
    { user: FIXTURE.user, token: FIXTURE.userToken },
    { user: FIXTURE.secondUser, token: FIXTURE.secondToken },
  ];
  for (const value of ['broken-json', '[null,17,{}]', '{"invalid":true}']) {
    await run(`dashboard: invalid account list remains usable (${value})`, async () => {
      const page = await open('/dashboard', { [USER_KEY]: FIXTURE.userToken, [accountKey]: value });
      await page.locator('.workspace-switch strong').filter({ hasText: FIXTURE.user }).waitFor();
      assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
    });
  }
  await run('dashboard: switch accounts stores no unlock material and logout keeps other sessions', async () => {
    const page = await open('/dashboard', { [USER_KEY]: FIXTURE.userToken, [accountKey]: JSON.stringify(savedAccounts) });
    await page.locator('.workspace-switch strong').filter({ hasText: FIXTURE.user }).waitFor();
    await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(FIXTURE.secondToken);
    await page.locator('.workspace-switch strong').filter({ hasText: FIXTURE.secondUser }).waitFor();
    assert.equal(await stored(page, USER_KEY), FIXTURE.secondToken);
    assert.equal(await stored(page, 'rsrs.superPass'), null);
    assert.equal(await stored(page, 'rsrs.secretKey'), null);
    await page.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
    await page.locator('.gate-form').waitFor();
    assert.equal(await stored(page, USER_KEY), '');
    assert.deepEqual(JSON.parse(await stored(page, accountKey)), savedAccounts.slice(0, 1));
  });
  await run('dashboard: page-memory unlock survives switching but not lock, reload or logout', async () => {
    const recovery = generateSecretKey();
    api.state.vault = await wrapVaultV4(recovery);
    const page = await open('/dashboard', { [USER_KEY]: FIXTURE.userToken, [accountKey]: JSON.stringify(savedAccounts) });
    const unlock = async () => {
      await page.getByRole('button', { name: t('unlockMemory'), exact: true }).click();
      await page.getByRole('dialog').getByLabel(t('labelSuperA3'), { exact: true }).fill(recovery);
      await page.getByRole('dialog').getByRole('button', { name: t('unlockView'), exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.locator('.memory-collection').waitFor();
      await assertNoRecoveryStorage(page);
    };
    await unlock();
    await page.locator('.memory-collection').waitFor();
    const select = page.getByLabel(t('switchAccount'), { exact: true });
    const swap = async token => {
      await select.selectOption(token);
      await page.locator('.workspace-switch strong').filter({ hasText: token === FIXTURE.userToken ? FIXTURE.user : FIXTURE.secondUser }).waitFor();
    };
    await swap(FIXTURE.secondToken);
    await page.locator('.locked-state').waitFor();
    await swap(FIXTURE.userToken);
    await page.locator('.memory-collection').waitFor();
    assert.equal(await stored(page, 'rsrs.superPass'), null, 'Restoring derived keys must not persist the recovery code');
    assert.equal(await stored(page, 'rsrs.secretKey'), null);
    await page.reload();
    await page.locator('.locked-state').waitFor();
    await unlock();
    await page.getByRole('button', { name: t('lock'), exact: true }).click();
    await swap(FIXTURE.secondToken);
    await swap(FIXTURE.userToken);
    await page.locator('.locked-state').waitFor();
    await unlock();
    await page.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
    await enterCredentials(page);
    await submit(page);
    await page.locator('.locked-state').waitFor();
  });

  for (const surface of ['dashboard', 'admin']) {
    await run(`${surface}: remove retired super password slots automatically without changing sessions`, async () => {
      const page = await open(`/${surface}`, { ...bothTokens,
        'onememory.superPass': 'synthetic-retired-recovery',
        'onememory.superPassAt': '12345', 'rsrs.keep-fixture': 'preserved',
      });
      await page.locator('.console-main').waitFor();
      for (const key of ['onememory.superPass', 'onememory.superPassAt']) assert.equal(await stored(page, key), null);
      assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
      assert.equal(await stored(page, ADMIN_KEY), FIXTURE.adminToken);
      assert.equal(await stored(page, 'rsrs.keep-fixture'), 'preserved');
      await page.addInitScript(() => {
        sessionStorage.setItem('onememory.superPass', 'synthetic-retired-recovery');
        sessionStorage.setItem('onememory.superPassAt', '12345');
      });
      await page.reload();
      await page.locator('.console-main').waitFor();
      assert.deepEqual(await page.evaluate(() => ['onememory.superPass', 'onememory.superPassAt'].map(key => sessionStorage.getItem(key))), [null, null]);
    });
  }

  await run('dashboard: legacy recovery requires backup confirmation and is never used to unlock', async () => {
    const recovery = generateSecretKey();
    api.state.vault = await wrapVaultV4(recovery);
    const legacy = { 'onememory.superPass': recovery, 'onememory.secretKey': 'synthetic-secret', 'rsrs.superPass': recovery };
    const page = await open('/dashboard', { [USER_KEY]: FIXTURE.userToken, ...legacy });
    await page.locator('.locked-state').waitFor();
    await page.getByRole('button', { name: t('unlockMemory'), exact: true }).click();
    assert.equal(await page.getByRole('dialog').getByLabel(t('labelSuperA3'), { exact: true }).inputValue(), '');
    await page.getByRole('dialog').getByRole('button', { name: t('cancel'), exact: true }).click();
    await page.goto(`${origin}/dashboard#/keys`);
    await page.getByText(t('legacyRecoveryWarning'), { exact: true }).waitFor();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: t('legacyRecoveryExport'), exact: true }).click();
    const backup = await downloadEvent;
    const chunks = [];
    for await (const chunk of await backup.createReadStream()) chunks.push(chunk);
    assert.equal(JSON.parse(Buffer.concat(chunks).toString())['localStorage:rsrs.superPass'], recovery);
    await page.getByRole('button', { name: t('legacyRecoveryClear'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: t('legacyRecoveryClear'), exact: true }).click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(await stored(page, 'onememory.superPass'), null);
    assert.equal(await stored(page, 'rsrs.superPass'), recovery);
    await dialog.getByLabel(t('legacyBackupConfirm'), { exact: true }).selectOption('yes');
    await dialog.getByRole('button', { name: t('legacyRecoveryClear'), exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    for (const key of Object.keys(legacy)) assert.equal(await stored(page, key), null);
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
  });

  await run('dashboard: blocked sessionStorage reads do not break recovery controls', async () => {
    const page = await open('/dashboard', { [USER_KEY]: FIXTURE.userToken });
    await page.locator('.workspace-switch strong').waitFor();
    await page.evaluate(() => {
      const read = Storage.prototype.getItem;
      Storage.prototype.getItem = function(key) {
        if (this === sessionStorage) throw new DOMException('fixture blocked', 'SecurityError');
        return read.call(this, key);
      };
    });
    await page.goto(`${origin}/dashboard#/keys`);
    await page.getByText(t('memoryOnlyDescription'), { exact: true }).first().waitFor();
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
  });
  await run('dashboard: token rotation preserves only the rotating account unlock session', async () => {
    const recovery = generateSecretKey();
    api.state.vault = await wrapVaultV4(recovery);
    const page = await open('/dashboard', { [USER_KEY]: FIXTURE.userToken, [accountKey]: JSON.stringify(savedAccounts) });
    const swap = async token => {
      await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(token);
      await page.waitForFunction(token => localStorage.getItem('rsrs.userToken') === token, token);
    };
    const unlock = async () => {
      await page.getByRole('button', { name: t('unlockMemory'), exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel(t('labelSuperA3'), { exact: true }).fill(recovery);
      await dialog.getByRole('button', { name: t('unlockView'), exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.locator('.memory-collection').waitFor();
    };
    await unlock();
    await swap(FIXTURE.secondToken);
    await unlock();
    await swap(FIXTURE.userToken);
    await page.locator('.memory-collection').waitFor();
    await page.goto(`${origin}/dashboard#/sessions`);
    await page.getByRole('button', { name: t('rotateToken'), exact: true }).click();
    await page.waitForFunction(() => localStorage.getItem('rsrs.userToken') === 'fixture-rotated-token');
    await page.goto(`${origin}/dashboard#/memories`);
    await page.locator('.memory-collection').waitFor();
    await assertNoRecoveryStorage(page);
    await swap(FIXTURE.secondToken);
    await page.locator('.memory-collection').waitFor();
    await swap('fixture-rotated-token');
    await page.locator('.memory-collection').waitFor();
    await page.getByRole('button', { name: t('lock'), exact: true }).click();
    await swap(FIXTURE.secondToken);
    await page.locator('.memory-collection').waitFor();
    await swap('fixture-rotated-token');
    await page.locator('.locked-state').waitFor();
    const accounts = JSON.parse(await stored(page, accountKey));
    assert.equal(accounts.some(row => row.token === FIXTURE.userToken), false);
  });

  await run('dashboard: add another login retains both sessions without passwords or keys', async () => {
    const page = await open('/dashboard', { [USER_KEY]: FIXTURE.userToken });
    await page.locator('.workspace-switch strong').filter({ hasText: FIXTURE.user }).waitFor();
    await page.getByRole('button', { name: t('addAccount'), exact: true }).click();
    await page.getByLabel(t('username'), { exact: true }).fill(FIXTURE.secondUser);
    await page.getByLabel(t('loginPassword'), { exact: true }).fill(FIXTURE.password);
    await submit(page);
    await page.locator('.workspace-switch strong').filter({ hasText: FIXTURE.secondUser }).waitFor();
    assert.deepEqual(JSON.parse(await stored(page, accountKey)), savedAccounts);
  });
  await run('dashboard: failed target session preserves active account', async () => {
    const expired = { user: 'expired-fixture', token: 'expired-fixture-token' };
    const page = await open('/dashboard', { [USER_KEY]: FIXTURE.userToken, [accountKey]: JSON.stringify([...savedAccounts, expired]) });
    await page.locator('.workspace-switch strong').filter({ hasText: FIXTURE.user }).waitFor();
    await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(expired.token);
    await page.getByRole('status').filter({ hasText: 'fixture expired session' }).waitFor();
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
    assert.equal(JSON.parse(await stored(page, accountKey)).some(row => row.token === expired.token), false);
  });
  await run('dashboard: late account switch cannot undo cross-tab logout', async () => {
    const page = await open('/dashboard', { [USER_KEY]: FIXTURE.userToken, [accountKey]: JSON.stringify(savedAccounts) });
    await page.locator('.workspace-switch strong').filter({ hasText: FIXTURE.user }).waitFor();
    let release;
    api.state.selfGates.set(FIXTURE.secondToken, new Promise(resolve => { release = resolve; }));
    const request = page.waitForRequest(r => new URL(r.url()).pathname === '/api/self' && r.headers().authorization === `Bearer ${FIXTURE.secondToken}`);
    await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(FIXTURE.secondToken);
    await request;
    const other = await context.newPage();
    await other.goto(`${origin}/dashboard`);
    await other.evaluate(() => localStorage.setItem('rsrs.userToken', ''));
    await page.locator('.gate-form').waitFor();
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/self' && r.request().headers().authorization === `Bearer ${FIXTURE.secondToken}`);
    release();
    await response;
    await page.waitForLoadState('networkidle');
    assert.equal(await stored(page, USER_KEY), '');
    assert.equal(await page.locator('.console-main').count(), 0);
  });
  await run('dashboard: session storage failure does not claim a successful switch', async () => {
    const page = await open('/dashboard', { [USER_KEY]: FIXTURE.userToken, [accountKey]: JSON.stringify(savedAccounts) });
    await page.locator('.workspace-switch strong').filter({ hasText: FIXTURE.user }).waitFor();
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'rsrs.userToken') throw new DOMException('fixture quota', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await page.getByLabel(t('switchAccount'), { exact: true }).selectOption(FIXTURE.secondToken);
    await page.getByRole('status').filter({ hasText: t('sessionStorageFailed') }).waitFor();
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
    assert.equal(await page.locator('.workspace-switch strong').textContent(), FIXTURE.user);
  });
  await run('dashboard: account list cleanup failure cannot prevent logout', async () => {
    const page = await open('/dashboard', { [USER_KEY]: FIXTURE.userToken, [accountKey]: JSON.stringify(savedAccounts) });
    await page.locator('.workspace-switch strong').filter({ hasText: FIXTURE.user }).waitFor();
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'rsrs.dashboard.accounts') throw new DOMException('fixture quota', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await page.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
    await page.locator('.gate-form').waitFor();
    await page.getByRole('status').filter({ hasText: t('accountListFailed') }).waitFor();
    assert.equal(await stored(page, USER_KEY), '');
  });

  for (const mode of ['dashboard', 'admin']) {
    await run(`${mode}: bare path selects its surface without credentials`, async () => {
      const page = await open(uiPath(mode));
      await page.locator(`.gate-page.${mode === 'admin' ? 'admin' : 'user'}-login`).waitFor();
      assert.equal(await page.locator('.gate-form h2').textContent(), t(mode === 'admin' ? 'gateAdminTitle' : 'gateWelcome'));
      assert.equal(await page.locator('.console-main').count(), 0);
    });

    await run(`${mode}: own token only, shell, and sign-out separation`, async () => {
      const start = api.requests.length;
      const page = await open(uiPath(mode), { 'onememory.userToken': FIXTURE.userToken, 'onememory.adminToken': FIXTURE.adminToken });
      await page.locator(`.console-main.surface-${mode === 'admin' ? 'users' : 'memories'}`).waitFor();
      // Let the shell's profile load finish before inspecting outgoing headers.
      await page.locator('.workspace-switch strong').filter({ hasText: mode === 'admin' ? FIXTURE.admin : FIXTURE.user }).waitFor();
      const token = mode === 'admin' ? FIXTURE.adminToken : FIXTURE.userToken;
      const calls = api.requests.slice(start).filter(r => r.method !== 'OPTIONS');
      assert.ok(calls.length > 0);
      assert.ok(calls.every(r => r.headers.cookie === undefined), 'API requests must not include cookies');
      assert.ok(calls.every(r => r.headers.authorization === `Bearer ${token}`), 'Other console token leaked into API requests');
      assert.ok(calls.every(r => mode === 'admin' ? r.path.startsWith('/admin/') : !r.path.startsWith('/admin/')));
      await page.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
      await page.locator('.gate-form').waitFor();
      assert.equal(await stored(page, mode === 'admin' ? ADMIN_KEY : USER_KEY), '');
      assert.equal(await stored(page, mode === 'admin' ? 'onememory.userToken' : 'onememory.adminToken'), mode === 'admin' ? FIXTURE.userToken : FIXTURE.adminToken);

      await page.reload();
      await page.locator('.gate-form').waitFor();
    });

    await run(`${mode}: opposite token cannot authenticate`, async () => {
      const start = api.requests.length;
      const page = await open(uiPath(mode), mode === 'admin' ? { [USER_KEY]: FIXTURE.userToken } : { [ADMIN_KEY]: FIXTURE.adminToken });
      await page.locator('.gate-form').waitFor();
      assert.equal(api.requests.length, start, 'Opposite console token must not be probed');
    });

    await run(`${mode}: 401 probe removes only the current token`, async () => {
      const probe = mode === 'admin' ? '/admin/me' : '/api/self';
      api.state.failures.set(`GET ${probe}`, { status: 401, error: 'fixture expired session' });
      const page = await open(uiPath(mode), bothTokens);
      await page.locator('.gate-form').waitFor();
      assert.equal(await stored(page, mode === 'admin' ? ADMIN_KEY : USER_KEY), '');
      assert.equal(await stored(page, mode === 'admin' ? USER_KEY : ADMIN_KEY), mode === 'admin' ? FIXTURE.userToken : FIXTURE.adminToken);
    });

    await run(`${mode}: password rejection and successful retry`, async () => {
      const other = mode === 'admin' ? { [USER_KEY]: FIXTURE.userToken } : { [ADMIN_KEY]: FIXTURE.adminToken };
      const page = await open(uiPath(mode), other);
      await enterCredentials(page, mode === 'admin', 'incorrect-fixture-password');
      await submit(page);
      await assertAlert(page, 'fixture invalid credentials');
      await enterCredentials(page, mode === 'admin');
      await submit(page);
      await page.locator('.console-main').waitFor();
      assert.equal(await stored(page, mode === 'admin' ? ADMIN_KEY : USER_KEY), mode === 'admin' ? FIXTURE.adminToken : FIXTURE.userToken);
      assert.equal(await stored(page, mode === 'admin' ? USER_KEY : ADMIN_KEY), mode === 'admin' ? FIXTURE.userToken : FIXTURE.adminToken);
    });

    await run(`${mode}: TOTP challenge, failed code, and retry`, async () => {
      api.state[mode === 'admin' ? 'adminTotp' : 'userTotp'] = true;
      const page = await open(uiPath(mode));
      await enterCredentials(page, mode === 'admin');
      await submit(page);
      const code = page.getByLabel(t('totpCode'), { exact: true });
      await code.waitFor();
      assert.equal(await page.getByLabel(t('loginPassword'), { exact: true }).count(), 0, 'Second factor uses its own page');
      assert.equal(await page.getByLabel(t('username'), { exact: true }).count(), 0);
      assert.equal(await stored(page, mode === 'admin' ? ADMIN_KEY : USER_KEY), null, 'Challenge must not create a session');
      await code.fill('000000');
      await submit(page, 'verify');
      await assertAlert(page, 'fixture invalid second factor');
      assert.equal(await stored(page, mode === 'admin' ? ADMIN_KEY : USER_KEY), null);
      if (mode === 'admin') {
        await code.fill('222222');
        await waitForApi(page, '/admin/login/totp', 'POST', () => submit(page, 'verify'));
        await page.locator('.gate-form form button[type="submit"]:enabled').waitFor();
        assert.equal(await stored(page, ADMIN_KEY), null, 'Renewed admin challenge must not create a session');
      }
      await code.fill(FIXTURE.totpCode);
      await submit(page, 'verify');
      await page.locator('.console-main').waitFor();
      assert.equal(await stored(page, mode === 'admin' ? ADMIN_KEY : USER_KEY), mode === 'admin' ? FIXTURE.adminToken : FIXTURE.userToken);
    });
  }

  await run('root path without a console prefix shows the fallback surface', async () => {
    const start = api.requests.length;
    const page = await open('/');
    await page.getByText(t('fallbackHint'), { exact: true }).waitFor();
    assert.equal(await page.locator('.gate-form, .console-main').count(), 0);
    assert.equal(api.requests.length, start, 'The fallback surface must not probe any API route');
    await page.goto(`${origin}/#/memories`);
    await page.getByText(t('fallbackHint'), { exact: true }).waitFor();
    assert.equal(await page.locator('.gate-form, .console-main').count(), 0);
  });

  await run('dashboard: path rest normalizes to hash deep links', async () => {
    const page = await open('/dashboard/sessions', bothTokens);
    await page.locator('.console-main.surface-sessions').waitFor();
    assert.equal(new URL(page.url()).hash, '#/sessions');
    for (const path of ['/dashboard#/dashboard/sessions', '/dashboard/#/dashboard/sessions', '/dashboard#/sessions']) {
      await page.goto(`${origin}${path}`);
      await page.locator('.console-main.surface-sessions').waitFor();
    }
    await navigate(page, 'security');
    await page.goBack();
    await page.locator('.console-main.surface-sessions').waitFor();
    await page.goForward();
    await page.locator('.console-main.surface-security').waitFor();
  });

  await run('admin: prefixed hash deep links', async () => {
    const page = await open('/admin#/audit', bothTokens);
    await page.locator('.console-main.surface-audit').waitFor();
    for (const path of ['/admin#/admin/audit', '/admin/#/admin/audit']) {
      await page.goto(`${origin}${path}`);
      await page.locator('.console-main.surface-audit').waitFor();
    }
    await navigate(page, 'security');
    await page.goBack();
    await page.locator('.console-main.surface-audit').waitFor();
    await page.goForward();
    await page.locator('.console-main.surface-security').waitFor();
  });

  await run('admin: daily stats ranges, missing history, timezone and responsive chart', async () => {
    const page = await open('/admin#/stats', bothTokens);
    await page.locator('.stats-panel .uplot').waitFor();
    await page.getByText(t('statsHistory', { date: '2026-10-05' }), { exact: true }).waitFor();
    for (const days of [7, 90, 30]) {
      await waitForApi(page, '/admin/stats', 'GET', () => page.getByRole('button', { name: t('statsDays', { n: days }), exact: true }).click());
      await page.locator('.stats-panel .uplot').waitFor();
      assert.ok(api.requests.some(r => r.path === '/admin/stats' && r.search === `?days=${days}`));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => {
      const plot = document.querySelector('.stats-panel .uplot');
      return plot && plot.getBoundingClientRect().width <= plot.parentElement.clientWidth + 1;
    });
    assert.equal(await stored(page, ADMIN_KEY), FIXTURE.adminToken);
  });

  await run('admin: daily stats viewer denial preserves both sessions', async () => {
    api.state.adminRole = 'viewer';
    const page = await open('/admin#/stats', bothTokens);
    await page.getByRole('alert').filter({ hasText: t('statsForbidden') }).waitFor();
    assert.equal(await page.locator('.stats-panel .uplot').count(), 0);
    assert.equal(await stored(page, ADMIN_KEY), FIXTURE.adminToken);
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
  });

  await run('admin: daily stats database error retries the same range', async () => {
    api.state.failures.set('GET /admin/stats', { status: 503, error: 'fixture database unavailable' });
    const page = await open('/admin#/stats', bothTokens);
    await page.getByRole('alert').filter({ hasText: t('statsLoadFailed') }).waitFor();
    api.state.failures.delete('GET /admin/stats');
    await waitForApi(page, '/admin/stats', 'GET', () => page.getByRole('button', { name: t('statsRetry'), exact: true }).click());
    await page.locator('.stats-panel .uplot').waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(await stored(page, ADMIN_KEY), FIXTURE.adminToken);
  });

  await run('admin: direct token login uses only admin credential slot', async () => {
    const page = await open('/admin', { [USER_KEY]: FIXTURE.userToken });
    await page.getByRole('button', { name: t('useAdminToken'), exact: true }).click();
    await page.getByLabel(t('adminToken'), { exact: true }).fill(FIXTURE.adminToken);
    await submit(page);
    await page.locator('.admin-console').waitFor();
    assert.equal(await stored(page, ADMIN_KEY), FIXTURE.adminToken);
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
  });

  for (const mode of ['dashboard', 'admin']) {
    await run(`${mode}: forbidden probe returns to its gate`, async () => {
      api.state.failures.set(`GET ${mode === 'admin' ? '/admin/me' : '/api/self'}`, { status: 403, error: 'fixture forbidden probe' });
      const page = await open(uiPath(mode), bothTokens);
      await page.locator('.gate-form').waitFor();
      assert.equal(await stored(page, mode === 'admin' ? ADMIN_KEY : USER_KEY), '');
      assert.equal(await stored(page, mode === 'admin' ? USER_KEY : ADMIN_KEY), mode === 'admin' ? FIXTURE.userToken : FIXTURE.adminToken);
    });
  }

  await run('admin: ordinary forbidden data response preserves session', async () => {
    api.state.failures.set('GET /admin/users', { status: 403, error: 'fixture role cannot list users' });
    const page = await open('/admin', bothTokens);
    await page.getByRole('status').filter({ hasText: 'fixture role cannot list users' }).waitFor();
    assert.equal(await stored(page, ADMIN_KEY), FIXTURE.adminToken);
    await page.locator('.admin-console').waitFor();
  });

  await run('admin: admin-token-required response clears only admin session', async () => {
    api.state.failures.set('GET /admin/users', { status: 403, error: 'admin token required' });
    const page = await open('/admin', bothTokens);
    await page.locator('.gate-form').waitFor();
    assert.equal(await stored(page, ADMIN_KEY), '');
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
  });

  await run('dashboard: forbidden and non-JSON errors remain retryable', async () => {
    const page = await open('/dashboard#/security', bothTokens);
    await emailTab(page);
    for (const failure of [{ status: 403, error: 'fixture email operation forbidden' }, { status: 502, raw: 'fixture upstream unavailable' }]) {
      api.state.failures.set('POST /api/self/email', failure);
      await page.getByRole('button', { name: t('sendCode'), exact: true }).click();
      await assertAlert(page, failure.error || failure.raw);
      assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
      assert.equal(await stored(page, ADMIN_KEY), FIXTURE.adminToken);
    }
    api.state.failures.delete('POST /api/self/email');
    await page.getByRole('button', { name: t('sendCode'), exact: true }).click();
    await page.getByLabel(t('emailCode'), { exact: true }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
  });

  await run('dashboard: runtime 401 clears user session without touching admin', async () => {
    const page = await open('/dashboard#/security', bothTokens);
    await emailTab(page);
    api.state.failures.set('POST /api/self/email', { status: 401, error: 'fixture revoked session' });
    await page.getByRole('button', { name: t('sendCode'), exact: true }).click();
    await page.locator('.gate-form').waitFor();
    assert.equal(await stored(page, USER_KEY), '');
    assert.equal(await stored(page, ADMIN_KEY), FIXTURE.adminToken);
  });

  await run('dashboard: email verification, invalid code, resend, and persisted UI', async () => {
    const page = await open('/dashboard#/security', bothTokens);
    await emailTab(page);
    await waitForApi(page, '/api/self/email', 'POST', () => page.getByRole('button', { name: t('sendCode'), exact: true }).click());
    await page.getByLabel(t('emailCode'), { exact: true }).fill('000000');
    await page.getByRole('button', { name: t('verifyAndBind'), exact: true }).click();
    await assertAlert(page, 'fixture invalid email code');
    assert.equal(api.state.emailVerified, false);
    await waitForApi(page, '/api/self/email', 'POST', () => page.getByRole('button', { name: t('resendCode'), exact: true }).click());
    await page.waitForFunction(() => document.querySelector('input[autocomplete="one-time-code"]')?.value === '');
    assert.equal(await page.getByLabel(t('emailCode'), { exact: true }).inputValue(), '');
    await page.getByLabel(t('emailCode'), { exact: true }).fill(FIXTURE.emailCode);
    await waitForApi(page, '/api/self/email/confirm', 'POST', () => page.getByRole('button', { name: t('verifyAndBind'), exact: true }).click());
    await page.getByText(t('currentEmail', { email: FIXTURE.email }), { exact: true }).waitFor();
    assert.equal(api.state.emailVerified, true);
    await page.locator('.security-tabs').getByRole('button', { name: t('overview'), exact: true }).click();
    await page.getByText(t('verified'), { exact: true }).waitFor();
    await page.reload();
    await page.getByText(t('verified'), { exact: true }).waitFor();
  });

  for (const mode of ['dashboard', 'admin']) {
    await run(`${mode}: local QR binding, invalid code retry and secret cleanup`, async () => {
      const page = await open(`/${mode}#/security`, bothTokens);
      await page.locator('.security-tabs').getByRole('button', { name: t('twoFactor'), exact: true }).click();
      const prefix = mode === 'admin' ? '/admin' : '/api/self';
      await waitForApi(page, `${prefix}/totp/begin`, 'POST', () => page.getByRole('button', { name: t('startBind'), exact: true }).click());
      const image = page.getByRole('img', { name: t('totpQrAlt'), exact: true });
      await image.waitFor();
      const source = await image.getAttribute('src');
      assert.ok(source.startsWith('data:image/png;base64,'), 'QR must be generated locally');
      const png = PNG.sync.read(Buffer.from(source.split(',')[1], 'base64'));
      const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
      assert.ok(decoded, 'QR must be scannable');
      const uri = new URL(decoded.data);
      assert.equal(uri.protocol, 'otpauth:');
      assert.equal(uri.searchParams.get('secret'), await page.locator('.setup-key code').textContent());
      assert.equal(uri.searchParams.get('issuer'), 'respire');
      assert.equal(uri.searchParams.get('period'), '30');
      assert.equal(uri.searchParams.get('digits'), '6');
      await page.setViewportSize({ width: 375, height: 812 });
      const box = await image.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 375, 'QR fits a mobile viewport');
      const code = page.getByLabel(t('totpCode'), { exact: true });
      const confirm = page.getByRole('button', { name: t('confirmOn'), exact: true });
      await code.fill('000000');
      await waitForApi(page, `${prefix}/totp/confirm`, 'POST', () => confirm.click(), 400);
      await assertAlert(page, 'fixture invalid second factor');
      assert.equal(await image.count(), 1);
      await code.fill(FIXTURE.totpCode);
      await waitForApi(page, `${prefix}/totp/confirm`, 'POST', () => confirm.click());
      await page.getByRole('heading', { name: t('totpBoundTitle'), exact: true }).waitFor();
      assert.equal(await image.count(), 0);
      assert.equal(await page.locator('.setup-key').count(), 0);
      assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
      assert.equal(await stored(page, ADMIN_KEY), FIXTURE.adminToken);
      await page.reload();
      await page.getByRole('button', { name: t('unbindTotp'), exact: true }).first().waitFor();
      assert.equal(await image.count(), 0);
    });
  }

  await run('dashboard: TOTP unbind retries preserve the session and binding state', async () => {
    api.state.userTotp = true;
    const page = await open('/dashboard#/security', bothTokens);
    await page.locator('.security-overview h2').getByText(t('totpOnH2'), { exact: true }).waitFor();
    await page.locator('.security-tabs').getByRole('button', { name: t('twoFactor'), exact: true }).click();
    const code = page.getByLabel(t('totpCode'), { exact: true });
    await page.getByRole('heading', { name: t('totpBoundTitle'), exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: t('startBind'), exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: t('confirmOn'), exact: true }).count(), 0);
    const disable = page.locator('.key-actions').getByRole('button', { name: t('unbindTotp'), exact: true });
    assert.equal(await disable.isEnabled(), false);
    await code.fill('000000');
    await waitForApi(page, '/api/self/totp/disable', 'POST', () => disable.click(), 400);
    await assertAlert(page, 'fixture invalid second factor');
    assert.equal(api.state.userTotp, true);
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
    await code.fill(FIXTURE.totpCode);
    await waitForApi(page, '/api/self/totp/disable', 'POST', () => disable.click());
    await page.locator('.security-overview h2').getByText(t('totpOffH2'), { exact: true }).waitFor();
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
    assert.equal(await stored(page, ADMIN_KEY), FIXTURE.adminToken);
    await page.getByRole('button', { name: t('startBind'), exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: t('unbindTotp'), exact: true }).count(), 0);
    assert.equal(await page.getByLabel(t('totpCode'), { exact: true }).count(), 0);
    await page.reload();
    await page.locator('.security-overview h2').getByText(t('totpOffH2'), { exact: true }).waitFor();
  });

  await run('dashboard: CLI authorization follows independent TOTP login and explicit approval', async () => {
    api.state.userTotp = true;
    const page = await open('/dashboard#/authorize?code=ABCDEF123456');
    await enterCredentials(page);
    await submit(page);
    await page.getByLabel(t('totpCode'), { exact: true }).fill(FIXTURE.totpCode);
    await submit(page, 'verify');
    await page.getByText('fixture-terminal', { exact: false }).waitFor();
    assert.equal(api.state.cliDecision, 'pending', 'Login alone must not authorize the CLI');
    await page.getByRole('button', { name: t('cliAuthorizeApprove'), exact: true }).click();
    await page.getByRole('status').getByText(t('cliAuthorizeDone'), { exact: true }).waitFor();
    assert.equal(api.state.cliDecision, 'approved');
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
  });

  await run('dashboard: GitHub login requires recovery code and preserves the existing vault', async () => {
    const recovery = generateSecretKey();
    api.state.vault = await wrapVaultV4(recovery);
    const original = JSON.stringify(api.state.vault);
    const page = await open('/dashboard');
    await page.getByRole('button', { name: t('githubContinue'), exact: true }).click();
    await page.getByLabel(t('superPassword'), { exact: true }).fill('wrong-recovery-code');
    await page.getByRole('button', { name: t('continue'), exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await stored(page, USER_KEY), null);
    await page.getByLabel(t('superPassword'), { exact: true }).fill(generateSecretKey());
    await page.getByRole('button', { name: t('continue'), exact: true }).click();
    await assertAlert(page, t('githubUnlockFailed'));
    assert.equal(await stored(page, USER_KEY), null);
    assert.equal(JSON.stringify(api.state.vault), original);
    await page.getByLabel(t('superPassword'), { exact: true }).fill(recovery);
    await page.getByRole('button', { name: t('continue'), exact: true }).click();
    await page.locator('.console-main').waitFor();
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
    assert.equal(JSON.stringify(api.state.vault), original);
    await assertNoRecoveryStorage(page);
    assert.equal(new URL(page.url()).search, '');
    assert.equal(api.requests.filter(r => r.method === 'POST' && r.path === '/oauth/github/exchange').length, 1);
  });

  await run('dashboard: new GitHub account confirms its locally generated recovery code before login', async () => {
    const page = await open('/dashboard');
    await page.getByRole('button', { name: t('githubContinue'), exact: true }).click();
    await page.getByRole('button', { name: t('generateSuper'), exact: true }).click();
    const recovery = await page.locator('.demo-key code').innerText();
    assert.match(recovery, /^A3-/);
    assert.equal(await stored(page, USER_KEY), null);
    assert.equal(await page.getByRole('button', { name: t('continue'), exact: true }).isEnabled(), false);
    assert.equal(api.state.vault, null, 'Do not upload a vault before the recovery code was confirmed saved');
    await page.getByLabel(t('confirmSavedSuper'), { exact: true }).check();
    await page.getByRole('button', { name: t('continue'), exact: true }).click();
    await page.locator('.console-main').waitFor();
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
    assert.equal(api.state.vault.version, 4);
    assert.equal((await unwrapUrk(recovery, undefined, api.state.vault)).length, 32);
    assert.ok(api.requests.every(r => !JSON.stringify(r.body || {}).includes(recovery)), 'Recovery code must stay local');
  });

  await run('dashboard: GitHub TOTP keeps the CLI authorization code through the redirect', async () => {
    api.state.userTotp = true;
    api.state.vault = await wrapVaultV4(generateSecretKey());
    const page = await open('/dashboard#/authorize?code=ABCDEF123456');
    await page.getByRole('button', { name: t('githubContinue'), exact: true }).click();
    await page.getByLabel(t('totpCode'), { exact: true }).fill('000000');
    await page.getByRole('button', { name: t('verify'), exact: true }).click();
    await assertAlert(page, 'fixture invalid second factor');
    assert.equal(await stored(page, USER_KEY), null);
    await page.getByLabel(t('totpCode'), { exact: true }).fill(FIXTURE.totpCode);
    await page.getByRole('button', { name: t('verify'), exact: true }).click();
    await page.getByText('fixture-terminal', { exact: false }).waitFor();
    assert.equal(api.state.cliDecision, 'pending');
    await page.getByRole('button', { name: t('cliAuthorizeApprove'), exact: true }).click();
    await page.getByRole('status').getByText(t('cliAuthorizeDone'), { exact: true }).waitFor();
    assert.equal(api.state.cliDecision, 'approved');
  });

  await run('dashboard: GitHub binding and unlinking retain the current session', async () => {
    const page = await open('/dashboard#/security', bothTokens);
    await page.getByRole('button', { name: t('githubBind'), exact: true }).click();
    await page.getByText('fixture-github', { exact: true }).waitFor();
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
    api.state.failures.set('POST /api/self/github/unbind', { status: 409, error: 'set a login password first' });
    await page.getByRole('button', { name: t('githubUnbind'), exact: true }).click();
    await assertAlert(page, 'set a login password first');
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
    api.state.failures.delete('POST /api/self/github/unbind');
    await page.getByRole('button', { name: t('githubUnbind'), exact: true }).click();
    await page.getByRole('button', { name: t('githubBind'), exact: true }).waitFor();
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
    assert.equal(await stored(page, ADMIN_KEY), FIXTURE.adminToken);
    await page.reload();
    await page.getByRole('button', { name: t('githubBind'), exact: true }).waitFor();
  });

  await run('dashboard: CLI authorization can be denied without signing out', async () => {
    const page = await open('/dashboard#/authorize?code=ABCDEF123456', bothTokens);
    await page.getByRole('button', { name: t('cliAuthorizeDeny'), exact: true }).click();
    await page.getByRole('status').getByText(t('cliAuthorizeDenied'), { exact: true }).waitFor();
    assert.equal(api.state.cliDecision, 'denied');
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
    assert.equal(await stored(page, ADMIN_KEY), FIXTURE.adminToken);
  });

  await run('dashboard: CLI authorization lookup errors allow editing without signing out', async () => {
    const page = await open('/dashboard#/authorize?code=000000000000', bothTokens);
    await assertAlert(page, 'fixture authorization code not found');
    await page.getByLabel(t('cliAuthorizeEnterCode'), { exact: true }).fill('ABCDEF123456');
    await page.getByRole('button', { name: t('cliAuthorizeApprove'), exact: true }).click();
    await page.getByRole('status').getByText(t('cliAuthorizeDone'), { exact: true }).waitFor();
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
    assert.equal(await stored(page, ADMIN_KEY), FIXTURE.adminToken);
  });

  await run('dashboard: registration vault and encrypted save/read/edit/deep link', async () => {
    const start = api.requests.length;
    const page = await open('/dashboard', { [ADMIN_KEY]: FIXTURE.adminToken });
    await page.locator('.gate-form .tabs').getByRole('button', { name: t('register'), exact: true }).click();
    await enterCredentials(page);
    await page.getByLabel(t('confirmLoginPassword'), { exact: true }).fill('fixture-mismatch');
    await submit(page, 'continue');
    await assertAlert(page, t('passMismatch'));
    await page.getByLabel(t('confirmLoginPassword'), { exact: true }).fill(FIXTURE.password);
    await submit(page, 'continue');
    await submit(page, 'generateSuper');
    await page.locator('.demo-key code').waitFor();
    const recovery = await page.locator('.demo-key code').textContent();
    assert.match(recovery, /^A3-(?:[0-9a-f]{6}-){5}[0-9a-f]{6}$/);
    assert.equal(await stored(page, USER_KEY), null, 'Registration requires acknowledging recovery material');
    assert.equal(await page.getByRole('button', { name: t('enterMemory'), exact: true }).isDisabled(), true);
    assert.equal(api.state.registered, true);
    assert.ok(api.state.vault);
    assert.ok(!JSON.stringify(api.requests.slice(start)).includes(recovery), 'Recovery key must not be sent to the API');
    await page.getByRole('checkbox').check();
    await submit(page, 'enterMemory');
    await page.getByRole('button', { name: t('saveMemory'), exact: true }).waitFor();
    assert.equal(await stored(page, ADMIN_KEY), FIXTURE.adminToken);
    await assertNoRecoveryStorage(page);
    const title = 'Synthetic fixture memory';
    const content = 'Only a synthetic encrypted fixture, with no personal data.';
    await page.getByRole('button', { name: t('saveMemory'), exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel(t('fieldTitle'), { exact: true }).fill(title);
    await dialog.getByLabel(t('fieldContent'), { exact: true }).fill(content);
    await waitForApi(page, '/push', 'POST', () => dialog.getByRole('button', { name: t('encryptUpload'), exact: true }).click());
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(api.state.blobs.size, 1);
    const [blob] = api.state.blobs.values();
    const key = await deriveDataKeys(await unwrapUrk(recovery, '', api.state.vault), true);
    const decrypted = JSON.parse(await decryptItem(key, blob.ciphertext, blob.nonce));
    assert.equal(decrypted.title, title);
    assert.equal(decrypted.content, content);
    const push = api.requests.find(r => r.method === 'POST' && r.path === '/push');
    assert.ok(!JSON.stringify(push.body).includes(title));
    assert.ok(!JSON.stringify(push.body).includes(content));
    await page.getByLabel(t('searchMemory'), { exact: true }).fill(title);
    await page.locator('.search-hit').filter({ hasText: title }).click();
    await page.locator('.reading-main').getByText(content, { exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, `#/memories/${blob.id}`);
    await page.getByRole('button', { name: t('edit'), exact: true }).click();
    dialog = page.getByRole('dialog');
    const edited = `${content} Edited through the browser.`;
    await dialog.getByLabel(t('fieldContent'), { exact: true }).fill(edited);
    await waitForApi(page, '/push', 'POST', () => dialog.getByRole('button', { name: t('saveEdit'), exact: true }).click());
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(api.state.blobs.size, 1, 'Editing must retain memory identity');
    const saved = api.state.blobs.get(blob.id);
    assert.equal(JSON.parse(await decryptItem(key, saved.ciphertext, saved.nonce)).content, edited);
    assert.ok(api.requests.some(r => r.path === '/api/self/memories' && r.search.includes('snapshot=0')), 'Saving should use incremental sync');
    const vaultReads = api.requests.filter(r => r.path === '/api/self/vault').length;
    await waitForApi(page, '/api/self/memories', 'GET', () => page.getByRole('button', { name: t('pullLatest'), exact: true }).click());
    assert.equal(api.requests.filter(r => r.path === '/api/self/vault').length, vaultReads, 'Pull latest must retain the unlocked controller without requesting the vault or saved key again');
    const collection = page.locator('.memory-collection');
    const beforeSync = await collection.boundingBox();
    let release;
    api.state.memoriesGate = new Promise(resolve => { release = resolve; });
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/self/memories');
    await page.getByRole('button', { name: t('pullLatest'), exact: true }).click();
    try {
      await page.locator('.memory-tip').waitFor();
      assert.equal(await page.locator('.memory-tip').evaluate(el => getComputedStyle(el).position), 'fixed');
      assert.equal((await collection.boundingBox()).y, beforeSync.y, 'Sync tip must not move the collection');
      assert.ok(!(await page.locator('.memory-tip').textContent()).includes('memoryLoading'));
    } finally { release(); api.state.memoriesGate = null; }
    await response;
    await page.locator('.memory-tip').waitFor({ state: 'hidden' });
    assert.equal((await collection.boundingBox()).y, beforeSync.y, 'Removing sync tip must not move the collection');
    const pagerIds = Array.from({ length: 24 }, (_, n) => `fixture-pager-${n}`);
    for (const id of pagerIds) api.state.blobs.set(id, { ...saved, id, revision: ++api.state.revision });
    await waitForApi(page, '/api/self/memories', 'GET', () => page.getByRole('button', { name: t('pullLatest'), exact: true }).click());
    await page.locator('.memory-status').getByText(t('nMemories', { n: 25 }), { exact: true }).waitFor();
    await page.getByLabel(t('searchMemory'), { exact: true }).fill('');
    await page.getByRole('tab', { name: t('cardView'), exact: true }).click();
    await page.locator('.pager').getByRole('button', { name: t('nextPage'), exact: true }).click();
    await page.locator('.pager-state').getByText(t('pageOf', { n: 2, total: 2 }), { exact: true }).waitFor();
    const removedId = pagerIds.at(-1);
    api.state.blobs.set(removedId, { ...api.state.blobs.get(removedId), deleted: true, revision: ++api.state.revision });
    await waitForApi(page, '/api/self/memories', 'GET', () => page.getByRole('button', { name: t('pullLatest'), exact: true }).click());
    await page.locator('.pager').waitFor({ state: 'hidden' });
    await page.locator('.memory-card').nth(23).waitFor();
    assert.equal(await page.locator('.memory-card').count(), 24, 'Deleting the last page must clamp the view rather than leave an empty page');
    for (const id of pagerIds.slice(0, -1)) api.state.blobs.set(id, { ...api.state.blobs.get(id), deleted: true, revision: ++api.state.revision });
    await waitForApi(page, '/api/self/memories', 'GET', () => page.getByRole('button', { name: t('pullLatest'), exact: true }).click());
    await page.locator('.memory-status').getByText(t('nMemories', { n: 1 }), { exact: true }).waitFor();
    await page.goto(`${origin}/dashboard/memories/${blob.id}`);
    await page.locator('.locked-state').waitFor();
    await page.getByRole('button', { name: t('unlockMemory'), exact: true }).click();
    await page.getByRole('dialog').getByLabel(t('labelSuperA3'), { exact: true }).fill(recovery);
    await page.getByRole('dialog').getByRole('button', { name: t('unlockView'), exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.locator('.reading-main').getByText(edited, { exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, `#/memories/${blob.id}`);
    await page.getByRole('button', { name: t('backMemory'), exact: true }).click();
    await page.getByRole('button', { name: t('lock'), exact: true }).click();
    await page.locator('.locked-state').waitFor();
    assert.equal(await page.locator('.reading-main').count(), 0);
    await page.getByRole('button', { name: t('unlockMemory'), exact: true }).click();
    await page.getByRole('dialog').getByLabel(t('labelSuperA3'), { exact: true }).fill(recovery);
    await page.getByRole('dialog').getByRole('button', { name: t('unlockView'), exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByLabel(t('searchMemory'), { exact: true }).fill(title);
    await page.locator('.search-hit').filter({ hasText: title }).click();
    await page.locator('.reading-main').getByText(edited, { exact: true }).waitFor();
    await page.reload();
    await page.locator('.locked-state').waitFor();
    await page.getByRole('button', { name: t('unlockMemory'), exact: true }).click();
    const recoveryField = page.getByRole('dialog').getByLabel(t('labelSuperA3'), { exact: true });
    assert.equal(await recoveryField.inputValue(), '', 'Reload must not prefill or auto-unlock');
    await recoveryField.fill(recovery);
    await page.getByRole('dialog').getByRole('button', { name: t('unlockView'), exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.locator('.reading-main').getByText(edited, { exact: true }).waitFor();
  });

  current = 'cross-origin transport proof';
  assert.ok(api.requests.length > 0, 'No API request was recorded');
  for (const record of api.requests) {
    assert.equal(record.origin, origin, 'Every API call must originate from the separate frontend');
  }
  assert.ok(api.requests.some(record => record.method === 'OPTIONS'), 'Native browser CORS preflights must reach the API');
  assert.ok(api.requests.every(r => proxy.requests.some(p => p.method === r.method && p.path === r.path)), 'Every API request must traverse the restricted proxy');
  assert.deepEqual(api.unexpected, []);
  assert.deepEqual(proxy.blocked, []);
  assert.deepEqual(proxy.errors, []);
  console.log(`PASS cross-origin API transport (${api.requests.length} requests through the restricted proxy)`);
  console.log(`Fixture browser regression passed: ${rows.length} scenarios, single console bundle, no live services.`);
} catch (error) {
  console.error(`FAIL ${current}`);
  if (api?.unexpected.length) console.error('Fixture errors:', api.unexpected);
  const withCookies = api?.requests.filter(r => r.headers.cookie !== undefined) || [];
  if (withCookies.length) console.error('Cookie-bearing API requests:', withCookies.map(r => `${r.method} ${r.path}`));
  if (proxy?.blocked.length) console.error('Blocked proxy requests:', proxy.blocked);
  if (proxy?.errors.length) console.error('Proxy errors:', proxy.errors);
  throw error;
} finally {
  await context?.close();
  await browser?.close();
  await proxy?.close();
  await api?.close();
  if (frontend) await closeServer(frontend);
  await rm(temporary, { recursive: true, force: true });
}
