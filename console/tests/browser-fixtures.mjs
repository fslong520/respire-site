import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { decryptItem, deriveDataKey, unwrapUrk } from '../src/crypto.js';
import { t } from '../src/i18n.js';
import { FIXTURE, startFixtureApi, closeServer, listen } from './fixture-api.mjs';
import { startFixtureProxy } from './fixture-proxy.mjs';

// Exercise the compiled single-file bundle against a real loopback service that
// serves the UI separately from the API, mirroring the Pages deployment.
// Both console paths serve the same bundle; JSON requests use the explicit API
// origin and native CORS. All network destinations except these ephemeral servers are
// blocked, and production dist is neither read nor overwritten by this suite.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'respire-console-fixtures-'));
const exec = promisify(execFile);
const USER_KEY = 'onememory.userToken';
const ADMIN_KEY = 'onememory.adminToken';
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
    ...(process.env.RESPIRE_BROWSER_EXECUTABLE ? { executablePath: process.env.RESPIRE_BROWSER_EXECUTABLE } : {}),
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
      const page = await open(uiPath(mode), bothTokens);
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
      assert.equal(await stored(page, mode === 'admin' ? ADMIN_KEY : USER_KEY), null);
      assert.equal(await stored(page, mode === 'admin' ? USER_KEY : ADMIN_KEY), mode === 'admin' ? FIXTURE.userToken : FIXTURE.adminToken);
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
      assert.equal(await stored(page, mode === 'admin' ? ADMIN_KEY : USER_KEY), null);
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
      assert.equal(await stored(page, mode === 'admin' ? ADMIN_KEY : USER_KEY), null);
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
    assert.equal(await stored(page, ADMIN_KEY), null);
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
    assert.equal(await stored(page, USER_KEY), null);
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
    const key = await deriveDataKey(await unwrapUrk(recovery, '', api.state.vault));
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
    assert.ok(api.requests.some(r => r.path === '/pull' && r.search.includes('since=')), 'Saving should use incremental sync');
    await page.goto(`${origin}/dashboard/memories/${blob.id}`);
    await page.locator('.reading-main').getByText(edited, { exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, `#/memories/${blob.id}`);
    await page.getByRole('button', { name: t('backMemory'), exact: true }).click();
    await page.getByRole('button', { name: t('lock'), exact: true }).click();
    await page.locator('.locked-state').waitFor();
    assert.equal(await page.locator('.reading-main').count(), 0);
    await page.getByRole('button', { name: t('unlockMemory'), exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: t('unlockView'), exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByLabel(t('searchMemory'), { exact: true }).fill(title);
    await page.locator('.search-hit').filter({ hasText: title }).click();
    await page.locator('.reading-main').getByText(edited, { exact: true }).waitFor();
    await page.evaluate(() => localStorage.setItem('onememory.superPassAt', String(Date.now() - 4 * 24 * 3600 * 1000)));
    await page.reload();
    await page.locator('.locked-state').waitFor();
    await page.getByRole('button', { name: t('unlockMemory'), exact: true }).click();
    const recoveryField = page.getByRole('dialog').getByLabel(t('labelSuperA3'), { exact: true });
    assert.equal(await recoveryField.inputValue(), '', 'Expired recovery codes must not prefill or auto-unlock');
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
