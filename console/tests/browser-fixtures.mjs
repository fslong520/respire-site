import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { decryptItem, deriveDataKey, unwrapUrk } from '../src/crypto.js';
import { t } from '../src/i18n.js';
import { FIXTURE, startFixtureApi, listen, closeServer } from './fixture-api.mjs';

// Exercise compiled mode-specific artifacts against a real, separate-origin
// loopback API. All network destinations except these ephemeral servers are
// blocked, and production dist is neither read nor overwritten by this suite.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'respire-console-fixtures-'));
const exec = promisify(execFile);
const api = await startFixtureApi();
const servers = [];
const origins = {};
const rows = [];
const outbound = [];
const wrongOriginApi = [];
const runtimeErrors = [];
const USER_KEY = 'onememory.userToken';
const ADMIN_KEY = 'onememory.adminToken';
const bothTokens = { [USER_KEY]: FIXTURE.userToken, [ADMIN_KEY]: FIXTURE.adminToken };
let browser;
let context;
let current = 'build';

async function run(name, body) {
  current = name;
  api.reset();
  const before = api.requests.length;
  try {
    await body();
    assert.deepEqual(api.unexpected, [], 'Fixture API encountered an unexpected request or payload');
    assert.deepEqual(outbound, [], 'Browser attempted to contact a non-fixture origin');
    assert.deepEqual(wrongOriginApi, [], 'API calls must use the configured separate origin');
    assert.deepEqual(runtimeErrors, [], 'Browser had an uncaught runtime error');
    rows.push({ name, requests: api.requests.length - before });
    console.log(`PASS ${name}`);
  } finally {
    await context?.close();
    context = undefined;
  }
}

async function open(mode, path = '/', storage = {}) {
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const allowed = new Set([api.origin, ...Object.values(origins)]);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (allowed.has(url.origin)) return route.continue();
    outbound.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    await route.abort('blockedbyclient');
  });
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
  await page.goto(`${origins[mode]}${path}`);
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
  for (const mode of ['dashboard', 'admin']) {
    const outDir = resolve(temporary, mode);
    await exec(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--mode', mode, '--outDir', outDir, '--emptyOutDir'], {
      cwd: root,
      env: { ...process.env, VITE_API_BASE_URL: api.origin },
      maxBuffer: 4 * 1024 * 1024,
    });
    const html = await readFile(resolve(outDir, 'index.html'));
    assert.ok(html.length > 10000, `${mode} artifact is unexpectedly empty`);
    const server = createServer((request, response) => {
      const path = new URL(request.url, 'http://fixture.invalid').pathname;
      if (path === '/favicon.ico') return response.writeHead(204).end();
      if (request.method !== 'GET' || path.startsWith('/api/') || ['/login', '/register', '/pull', '/push', '/admin/me', '/admin/users'].includes(path)) {
        wrongOriginApi.push(`${request.method} ${path}`);
        return response.writeHead(500).end('API must be called on its configured origin');
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
    });
    servers.push(server);
    origins[mode] = await listen(server);
    api.origins.add(origins[mode]);
  }
  assert.equal(new Set([api.origin, origins.dashboard, origins.admin]).size, 3);
  current = 'launch browser';
  browser = await chromium.launch({ headless: true, ...(process.env.RESPIRE_BROWSER_EXECUTABLE ? { executablePath: process.env.RESPIRE_BROWSER_EXECUTABLE } : {}) });

  for (const mode of ['dashboard', 'admin']) {
    await run(`${mode}: root selects compiled mode without credentials`, async () => {
      const page = await open(mode);
      await page.locator(`.gate-page.${mode === 'admin' ? 'admin' : 'user'}-login`).waitFor();
      assert.equal(await page.locator('.gate-form h2').textContent(), t(mode === 'admin' ? 'gateAdminTitle' : 'gateWelcome'));
      assert.equal(await page.locator('.console-main').count(), 0);
    });

    await run(`${mode}: opposite legacy path cannot switch compiled surface`, async () => {
      const start = api.requests.length;
      const opposite = mode === 'admin' ? 'dashboard' : 'admin';
      const page = await open(mode, `/${opposite}/security`, bothTokens);
      await page.getByText(t('fallbackHint'), { exact: true }).waitFor();
      assert.equal(await page.locator('.gate-form, .console-main').count(), 0);
      assert.equal(api.requests.length, start, 'Unsupported path must not start an authenticated console');
    });

    await run(`${mode}: own token only, root shell, and sign-out separation`, async () => {
      const start = api.requests.length;
      const page = await open(mode, '/', bothTokens);
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
      const page = await open(mode, '/', mode === 'admin' ? { [USER_KEY]: FIXTURE.userToken } : { [ADMIN_KEY]: FIXTURE.adminToken });
      await page.locator('.gate-form').waitFor();
      assert.equal(api.requests.length, start, 'Opposite console token must not be probed');
    });

    await run(`${mode}: legacy path and prefixed hash deep links`, async () => {
      const id = mode === 'admin' ? 'audit' : 'sessions';
      const page = await open(mode, `/${mode}/${id}`, bothTokens);
      await page.locator(`.console-main.surface-${id}`).waitFor();
      assert.equal(new URL(page.url()).hash, `#/${id}`);
      for (const path of [`/${mode}#/${mode}/${id}`, `/${mode}/#/${mode}/${id}`, `/#/${mode}/${id}`, `/#/${id}`]) {
        await page.goto(`${origins[mode]}${path}`);
        await page.locator(`.console-main.surface-${id}`).waitFor();
      }
      await navigate(page, 'security');
      await page.goBack();
      await page.locator(`.console-main.surface-${id}`).waitFor();
      await page.goForward();
      await page.locator('.console-main.surface-security').waitFor();
    });

    await run(`${mode}: 401 probe removes only the current token`, async () => {
      const probe = mode === 'admin' ? '/admin/me' : '/api/self';
      api.state.failures.set(`GET ${probe}`, { status: 401, error: 'fixture expired session' });
      const page = await open(mode, '/', bothTokens);
      await page.locator('.gate-form').waitFor();
      assert.equal(await stored(page, mode === 'admin' ? ADMIN_KEY : USER_KEY), null);
      assert.equal(await stored(page, mode === 'admin' ? USER_KEY : ADMIN_KEY), mode === 'admin' ? FIXTURE.userToken : FIXTURE.adminToken);
    });

    await run(`${mode}: password rejection and successful retry`, async () => {
      const other = mode === 'admin' ? { [USER_KEY]: FIXTURE.userToken } : { [ADMIN_KEY]: FIXTURE.adminToken };
      const page = await open(mode, '/', other);
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
      const page = await open(mode);
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

  await run('admin: direct token login uses only admin credential slot', async () => {
    const page = await open('admin', '/', { [USER_KEY]: FIXTURE.userToken });
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
      const page = await open(mode, '/', bothTokens);
      await page.locator('.gate-form').waitFor();
      assert.equal(await stored(page, mode === 'admin' ? ADMIN_KEY : USER_KEY), null);
      assert.equal(await stored(page, mode === 'admin' ? USER_KEY : ADMIN_KEY), mode === 'admin' ? FIXTURE.userToken : FIXTURE.adminToken);
    });
  }

  await run('admin: ordinary forbidden data response preserves session', async () => {
    api.state.failures.set('GET /admin/users', { status: 403, error: 'fixture role cannot list users' });
    const page = await open('admin', '/', bothTokens);
    await page.getByRole('status').filter({ hasText: 'fixture role cannot list users' }).waitFor();
    assert.equal(await stored(page, ADMIN_KEY), FIXTURE.adminToken);
    await page.locator('.admin-console').waitFor();
  });

  await run('admin: admin-token-required response clears only admin session', async () => {
    api.state.failures.set('GET /admin/users', { status: 403, error: 'admin token required' });
    const page = await open('admin', '/', bothTokens);
    await page.locator('.gate-form').waitFor();
    assert.equal(await stored(page, ADMIN_KEY), null);
    assert.equal(await stored(page, USER_KEY), FIXTURE.userToken);
  });

  await run('dashboard: forbidden and non-JSON errors remain retryable', async () => {
    const page = await open('dashboard', '/#/security', bothTokens);
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
    const page = await open('dashboard', '/#/security', bothTokens);
    await emailTab(page);
    api.state.failures.set('POST /api/self/email', { status: 401, error: 'fixture revoked session' });
    await page.getByRole('button', { name: t('sendCode'), exact: true }).click();
    await page.locator('.gate-form').waitFor();
    assert.equal(await stored(page, USER_KEY), null);
    assert.equal(await stored(page, ADMIN_KEY), FIXTURE.adminToken);
  });

  await run('dashboard: email verification, invalid code, resend, and persisted UI', async () => {
    const page = await open('dashboard', '/#/security', bothTokens);
    await emailTab(page);
    await waitForApi(page, '/api/self/email', 'POST', () => page.getByRole('button', { name: t('sendCode'), exact: true }).click());
    await page.getByLabel(t('emailCode'), { exact: true }).fill('000000');
    await page.getByRole('button', { name: t('verifyAndBind'), exact: true }).click();
    await assertAlert(page, 'fixture invalid email code');
    assert.equal(api.state.emailVerified, false);
    await waitForApi(page, '/api/self/email', 'POST', () => page.getByRole('button', { name: t('resendCode'), exact: true }).click());
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
    const page = await open('dashboard', '/', { [ADMIN_KEY]: FIXTURE.adminToken });
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
    await page.goto(`${origins.dashboard}/dashboard/memories/${blob.id}`);
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

  current = 'CORS proof';
  for (const [path, method, header] of [['/api/self', 'GET', 'authorization'], ['/admin/me', 'GET', 'authorization'], ['/login', 'POST', 'content-type'], ['/admin/login', 'POST', 'content-type'], ['/api/self/vault', 'POST', 'authorization'], ['/push', 'POST', 'content-type']]) {
    assert.ok(api.requests.some(r => r.method === 'OPTIONS' && r.path === path && r.headers['access-control-request-method'] === method && (r.headers['access-control-request-headers'] || '').includes(header)), `Missing real CORS preflight for ${method} ${path} (${header})`);
  }
  for (const origin of Object.values(origins)) assert.ok(api.requests.some(r => r.method === 'OPTIONS' && r.origin === origin), 'Each built console must perform a cross-origin preflight');
  assert.deepEqual(api.unexpected, []);
  assert.deepEqual(outbound, []);
  assert.deepEqual(wrongOriginApi, []);
  assert.deepEqual(runtimeErrors, []);
  console.log(`PASS real HTTP CORS preflights (${api.requests.filter(r => r.method === 'OPTIONS').length} OPTIONS requests)`);
  console.log(`Fixture browser regression passed: ${rows.length} scenarios, both compiled modes, no live services.`);
} catch (error) {
  console.error(`FAIL ${current}`);
  if (api.unexpected.length) console.error('Fixture errors:', api.unexpected);
  if (outbound.length) console.error('Blocked outbound requests:', outbound);
  if (wrongOriginApi.length) console.error('Wrong-origin API requests:', wrongOriginApi);
  throw error;
} finally {
  await context?.close();
  await browser?.close();
  await Promise.all(servers.map(closeServer));
  await api.close();
  await rm(temporary, { recursive: true, force: true });
}
