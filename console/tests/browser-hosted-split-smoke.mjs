import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { authPayload, decryptItem, deriveDataKeys, unwrapUrk } from '../src/crypto.js';
import { t } from '../src/i18n.js';
import { installHostedBrowserGuard } from './hosted-browser-guard.mjs';
import { readHostedConfig, verifyCheckoutSource, verifyHostedProvenance } from './hosted-split-contract.mjs';

// Opt-in only. Keep browser-dev-smoke.mjs unchanged as imported provenance.
async function main() {

const config = readHostedConfig(process.env); // No IO, browser, or mail before all gates pass.
const { origins, serverSha: expectedSha, siteSha, adminToken, mailAddress, mailReader } = config;
const upstream = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
const readMail = promisify(execFile);
const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
const git = args => readMail('git', args, { cwd: sourceRoot, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
const { stdout: checkoutSha } = await git(['rev-parse', 'HEAD']);
const { stdout: checkoutStatus } = await git(['status', '--porcelain', '--untracked-files=normal']);
verifyCheckoutSource(checkoutSha, checkoutStatus, config);
const outputRoot = resolve(config.output);
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const output = await mkdtemp(resolve(outputRoot, 'run-'));
const run = `${Date.now()}-${randomBytes(8).toString('hex')}`;
const user = `web-smoke-${run}`;
const email = mailAddress;
const password = randomBytes(20).toString('hex');
const nextPassword = randomBytes(20).toString('hex');
const owner = `web-owner-${run}`;
const viewer = `web-viewer-${run}`;
const ownerPassword = randomBytes(20).toString('hex');
const viewerPassword = randomBytes(20).toString('hex');
const rows = [];
const created = new Set();
let current = 'launch';
let browser;
let context;
let page;
let browserGuard;
let userToken;
let ownerToken;
let viewerToken;
let recovery;
let totpSecret;
let fatal = false;
const networkFailures = [];
let runtimeErrors = 0;

// The shared raw-CDP guard is exercised by the local-only CORS regression.
// APIRequestContext calls separately disable redirects with maxRedirects:0.
async function protectBrowser() {
  browserGuard = await installHostedBrowserGuard({ context, page, config, failures: networkFailures });
await context.addInitScript(() => localStorage.setItem('respire.uiLocale', 'en'));
// Own the fixture as soon as registration is acknowledged, even if the next
// vault write or recovery-code rendering fails. Never adopt pre-existing users.
page.on('response', response => {
  const url = new URL(response.url());
  if (url.origin !== origins.api || url.pathname !== '/register' || response.request().method() !== 'POST' || response.status() !== 200) return;
  try {
    if (response.request().postDataJSON()?.user === user) created.add(user);
  } catch {} // A malformed response cannot establish fixture ownership.
});

}

async function step(name, body) {
  current = name;
  await body();
  assert.equal(runtimeErrors, 0, 'Browser had an uncaught runtime error');
  assert.equal(networkFailures.length, 0, 'Browser attempted an unauthorized origin, redirect, or frontend API call');
  rows.push({ name, status: 'pass' });
  console.log(`PASS ${name}`);
}
async function call(path, { method = 'GET', token, body, form, expected = 200 } = {}) {
  assert.ok(body === undefined || form === undefined, 'A request cannot send JSON and form bodies together');
  const response = await context.request.fetch(`${origins.api}${path}`, { method, maxRedirects: 0, timeout: 30000, ...(body === undefined ? {} : { data: body }), ...(form === undefined ? {} : { form }), headers: token ? { Authorization: `Bearer ${token}` } : {} });
  assert.equal(response.status(), expected, 'Isolated API returned an unexpected status');
  if (method === 'POST' && path === '/admin/admins' && token === adminToken && [owner, viewer].includes(body?.user)) created.add(body.user);
  return response.json();
}
async function receivedCode(purpose, requestedAt) {
  const waitSeconds = config.mailWaitSeconds;
  assert.ok(Number.isFinite(waitSeconds) && waitSeconds >= 30 && waitSeconds <= 600);
  console.log('WAITING_FOR_MAIL ' + purpose);
  const deadline = performance.now() + waitSeconds * 1000;
  while (performance.now() < deadline) {
    let stdout;
    const remaining = Math.max(1, Math.floor(deadline - performance.now()));
    try {
      ({ stdout } = await readMail(mailReader[0], [...mailReader.slice(1), JSON.stringify({ recipient: email, requestedAt, purpose })], { timeout: Math.min(15000, remaining), maxBuffer: 4096 }));
    } catch {
      if (performance.now() >= deadline) break;
      throw new Error('Isolated mailbox reader failed; credentials and message contents are not logged.');
    }
    let received;
    try { received = JSON.parse(stdout); } catch { throw new Error('Isolated mailbox reader returned invalid JSON.'); }
    if (typeof received.code === 'string' && /^\d{6}$/.test(received.code)) return received.code;
    const pause = Math.min(2000, deadline - performance.now());
    if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause));
  }
  throw new Error('Verification email was not received before the deadline');
}

async function screenshot(name) {
  await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true, animations: 'disabled', mask: [page.locator('input'), page.locator('textarea'), page.locator('code'), page.locator('pre'), page.locator('.demo-key'), page.locator('.setup-key'), page.locator('.verification-code'), page.locator('.secret-result'), page.getByRole('alert')] });
  await chmod(resolve(output, `${name}.png`), 0o600);
}
async function navigate(id) {
  await page.locator(`.console-sidebar nav a[href="#/${id}"]`).click();
  await page.locator(`.console-main.surface-${id}`).waitFor();
}
async function responseFor(path, action) {
  const reply = page.waitForResponse(r => new URL(r.url()).origin === origins.api && new URL(r.url()).pathname === path && r.request().method() === 'POST');
  await action();
  assert.equal((await reply).status(), 200, 'Browser operation did not succeed');
}
function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.toUpperCase().replace(/=+$/, '')) {
    const value = alphabet.indexOf(char);
    assert.ok(value >= 0, 'Fixture TOTP secret format invalid');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from(bits.match(/.{8}/g).map(b => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hash = createHmac('sha1', bytes).update(counter).digest();
  const offset = hash.at(-1) & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

try {
browser = await chromium.launch({ headless: true, ...(config.executablePath ? { executablePath: config.executablePath } : {}) });
context = await browser.newContext({ baseURL: origins.dashboard, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
page = await context.newPage();
page.setDefaultTimeout(30000);
  await protectBrowser();
  page.on('pageerror', () => { runtimeErrors += 1; });
  await step('exact-server-site-homepage-source-and-readiness', async () => {
    // Fail closed on absent, stale, dirty, or mismatched metadata before writes.
    await verifyHostedProvenance(context.request, config, upstream.commit);
  });
  await step('homepage-real-browser-load', async () => {
    await page.goto(`${origins.homepage}/`);
    await page.locator('main h1').waitFor();
    assert.match(await page.title(), /Respire/i);
    assert.equal(new URL(page.url()).origin, origins.homepage);
    await screenshot('homepage');
  });
  await step('split-origin-root-and-legacy-routes', async () => {
    for (const target of ['dashboard', 'admin']) {
      for (const path of ['/', `/${target}`]) {
        await page.goto(`${origins[target]}${path}`);
        await page.locator(`.gate-page.${target === 'admin' ? 'admin' : 'user'}-login`).waitFor();
        // Finish shared font loads before the next navigation cancels CDP interceptions.
        await page.waitForLoadState('networkidle');
        assert.equal(new URL(page.url()).origin, origins[target]);
      }
    }
  });
  await step('user-login-failure-and-register-form', async () => {
    await page.goto(`${origins.dashboard}/`);
    await page.getByLabel(t('username'), { exact: true }).fill(user);
    await page.getByLabel(t('loginPassword'), { exact: true }).fill(password);
    await page.locator('.gate-form form').getByRole('button', { name: t('login'), exact: true }).click();
    await page.getByRole('alert').waitFor();
    await screenshot('user-login');
    await page.locator('.gate-form .tabs').getByRole('button', { name: t('register'), exact: true }).click();
    await page.getByLabel(t('confirmLoginPassword'), { exact: true }).fill('different-fixture-password');
    await page.getByRole('button', { name: t('continue'), exact: true }).click();
    assert.equal(await page.getByRole('alert').textContent(), t('passMismatch'));
    await page.getByLabel(t('confirmLoginPassword'), { exact: true }).fill(password);
    await page.getByRole('button', { name: t('continue'), exact: true }).click();
    await page.getByRole('button', { name: t('generateSuper'), exact: true }).click();
    await page.locator('.demo-key code').waitFor();
    recovery = await page.locator('.demo-key code').textContent();
    created.add(user);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: t('enterMemory'), exact: true }).click();
    await page.locator('.console-main').waitFor();
    userToken = await page.evaluate(() => localStorage.getItem('rsrs.userToken'));
    assert.ok(userToken);
  });
  const title = `Synthetic browser memory ${run}`;
  const content = 'Synthetic browser-only content. No personal data.';
  await step('encrypted-memory-create-read-edit', async () => {
    await page.getByRole('button', { name: t('saveMemory'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(t('fieldTitle'), { exact: true }).fill(title);
    await dialog.getByLabel(t('fieldContent'), { exact: true }).fill(content);
    await responseFor('/push', () => dialog.getByRole('button', { name: t('encryptUpload'), exact: true }).click());
    await dialog.waitFor({ state: 'hidden' });
    await page.getByLabel(t('searchMemory'), { exact: true }).fill(title);
    await page.locator('.search-hit').filter({ hasText: title }).click();
    await page.locator('.reading-main').getByText(content, { exact: true }).waitFor();
    await screenshot('memory-read');
    await page.getByRole('button', { name: t('edit'), exact: true }).click();
    await page.getByRole('dialog').getByLabel(t('fieldContent'), { exact: true }).fill(`${content} Edited in the real browser.`);
    await responseFor('/push', () => page.getByRole('dialog').locator('button[type="submit"]').click());
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const vault = await call('/api/self/vault', { token: userToken });
    const key = await deriveDataKeys(await unwrapUrk(recovery, '', vault));
    const pull = await call('/pull', { token: userToken });
    let found = false;
    for (const blob of pull.blobs || []) {
      if (blob.deleted) continue;
      const memory = JSON.parse(await decryptItem(key, blob.ciphertext, blob.nonce));
      if (memory.title === title) {
        assert.equal(memory.content, `${content} Edited in the real browser.`);
        assert.ok(!blob.ciphertext.includes(content));
        found = true;
      }
    }
    assert.ok(found, 'Edited fixture did not round-trip through encrypted storage');
  });
  await step('all-user-view-layouts-and-mobile-navigation', async () => {
    for (const id of ['memories', 'diary', 'sessions', 'keys', 'security']) {
      await navigate(id);
      await page.locator('.page-heading h1').waitFor();
      await screenshot(`user-${id}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: t('openNav'), exact: true }).click();
    await navigate('sessions');
    assert.equal(await page.locator('.console-sidebar.open').count(), 0);
    await screenshot('user-mobile');
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await step('profile-email-verification-and-mail-fixture', async () => {
    await navigate('security');
    await page.locator('.security-tabs').getByRole('button', { name: t('bindEmail'), exact: true }).click();
    await page.getByLabel(t('emailAddress'), { exact: true }).fill(email);
    const requestedAt = new Date().toISOString();
    await responseFor('/api/self/email', () => page.getByRole('button', { name: t('sendCode'), exact: true }).click());
    const mail = await call('/admin/outbox', { token: adminToken });
    const fixture = mail.items?.find(m => m.to === email);
    assert.ok(fixture, 'Isolated verification mail row absent');
    assert.equal(fixture.body, undefined, 'Administrator API must not expose verification codes');
    const code = await receivedCode('verify_email', requestedAt);
    await page.getByLabel(t('emailCode'), { exact: true }).fill(code);
    await responseFor('/api/self/email/confirm', () => page.getByRole('button', { name: t('verifyAndBind'), exact: true }).click());
    assert.equal((await call('/api/self/keys', { token: userToken })).email, email);
    await page.getByText(t('currentEmail', { email }), { exact: true }).waitFor();
    await page.locator('.security-tabs').getByRole('button', { name: t('overview'), exact: true }).click();
    await page.getByText(t('verified'), { exact: true }).waitFor();
    await page.reload();
    await page.getByText(t('verified'), { exact: true }).waitFor();
  });
  await step('user-totp-confirm-login-challenge-and-disable', async () => {
    await page.locator('.security-tabs').getByRole('button', { name: t('twoFactor'), exact: true }).click();
    await page.getByRole('button', { name: t('startBind'), exact: true }).click();
    await page.locator('.setup-key code').waitFor();
    totpSecret = await page.locator('.setup-key code').textContent();
    await page.getByLabel(t('totpCode'), { exact: true }).fill(totp(totpSecret));
    await responseFor('/api/self/totp/confirm', () => page.getByRole('button', { name: t('confirmOn'), exact: true }).click());
    await page.locator('.security-overview h2').getByText(t('totpOnH2'), { exact: true }).waitFor();
    await page.locator('.security-tabs').getByRole('button', { name: t('overview'), exact: true }).click();
    await page.locator('.settings-panel').getByText(t('totpOn'), { exact: true }).waitFor();
    await page.reload();
    await page.locator('.security-overview h2').getByText(t('totpOnH2'), { exact: true }).waitFor();
    await page.getByText(t('verified'), { exact: true }).waitFor();
    await page.locator('.settings-panel').getByText(t('totpOn'), { exact: true }).waitFor();
    await page.locator('.security-tabs').getByRole('button', { name: t('twoFactor'), exact: true }).click();
    const auth = await authPayload(user, password);
    const challenge = await call('/login', { method: 'POST', body: { user, pass_hash: auth.pass_hash, device_name: 'hosted-split-smoke-challenge' } });
    assert.equal(challenge.totp_required, true);
    await call('/login/totp', { method: 'POST', body: { ticket: challenge.ticket, code: 'invalid-code' }, expected: 401 });
    const nextChallenge = await call('/login', { method: 'POST', body: { user, pass_hash: auth.pass_hash, device_name: 'hosted-split-smoke-challenge' } });
    const session = await call('/login/totp', { method: 'POST', body: { ticket: nextChallenge.ticket, code: totp(totpSecret), device_name: 'hosted-split-smoke-secondary' } });
    assert.ok(session.token);
    // Enter OAuth from a signed-out browser so real password and independent
    // second-factor pages precede an explicit, separately verified decision.
    const grant = await call('/oauth/device/code', { method: 'POST',
      form: { client_id: 'respire-cli', device_name: 'hosted-split-smoke-cli', expected_user: user },
    });
    assert.match(grant.user_code, /^[A-Fa-f0-9]{12}$/);
    assert.equal(grant.verification_uri_complete, `${origins.dashboard}/#/authorize?code=${grant.user_code}`);
    await page.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
    await page.goto(grant.verification_uri_complete);
    await page.getByLabel(t('username'), { exact: true }).fill(user);
    await page.getByLabel(t('loginPassword'), { exact: true }).fill(password);
    assert.equal(await page.getByLabel(t('superOptional'), { exact: true }).count(), 0);
    await responseFor('/login', () => page.locator('.gate-form form').getByRole('button', { name: t('login'), exact: true }).click());
    const secondFactor = page.getByLabel(t('totpCode'), { exact: true });
    await secondFactor.waitFor();
    assert.equal(await page.getByLabel(t('username'), { exact: true }).count(), 0);
    assert.equal(await page.getByLabel(t('loginPassword'), { exact: true }).count(), 0);
    await secondFactor.fill(String((Number(totp(totpSecret)) + 1) % 1000000).padStart(6, '0'));
    const rejected = page.waitForResponse(r => new URL(r.url()).origin === origins.api && new URL(r.url()).pathname === '/login/totp' && r.request().method() === 'POST');
    await page.locator('.gate-form form').getByRole('button', { name: t('verify'), exact: true }).click();
    assert.equal((await rejected).status(), 401);
    await page.getByRole('alert').waitFor();
    await secondFactor.fill(totp(totpSecret));
    await responseFor('/login/totp', () => page.locator('.gate-form form').getByRole('button', { name: t('verify'), exact: true }).click());
    await page.getByText('hosted-split-smoke-cli', { exact: false }).waitFor();
    await page.locator('.gate-form').getByText(`${t('username')}: ${user}`, { exact: true }).waitFor();
    assert.equal(await page.locator('.setup-key code').textContent(), grant.user_code.toUpperCase());
    userToken = await page.evaluate(() => localStorage.getItem('rsrs.userToken'));
    assert.ok(userToken);
    assert.equal((await call(`/api/self/cli-authorization/${grant.user_code}`, { token: userToken })).state, 'pending');
    await responseFor(`/api/self/cli-authorization/${grant.user_code}`, () => page.getByRole('button', { name: t('cliAuthorizeApprove'), exact: true }).click());
    await page.getByRole('status').getByText(t('cliAuthorizeDone'), { exact: true }).waitFor();
    const cliSession = await call('/oauth/token', { method: 'POST',
      form: { client_id: 'respire-cli', grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: grant.device_code },
    });
    assert.equal(cliSession.user, user);
    assert.equal((await call('/api/self', { token: cliSession.access_token })).user, user);
    assert.equal(await page.evaluate(() => localStorage.getItem('rsrs.userToken')), userToken);
    const denied = await call('/oauth/device/code', { method: 'POST',
      form: { client_id: 'respire-cli', device_name: 'hosted-split-smoke-denied', expected_user: user },
    });
    assert.equal(denied.verification_uri_complete, `${origins.dashboard}/#/authorize?code=${denied.user_code}`);
    await page.goto(denied.verification_uri_complete);
    await responseFor(`/api/self/cli-authorization/${denied.user_code}`, () => page.getByRole('button', { name: t('cliAuthorizeDeny'), exact: true }).click());
    await page.getByRole('status').getByText(t('cliAuthorizeDenied'), { exact: true }).waitFor();
    const rejection = await call('/oauth/token', { method: 'POST', expected: 400,
      form: { client_id: 'respire-cli', grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: denied.device_code },
    });
    assert.equal(rejection.error, 'access_denied');
    assert.equal(await page.evaluate(() => localStorage.getItem('rsrs.userToken')), userToken);
    await page.goto(`${origins.dashboard}/#/security`);
    await page.locator('.security-tabs').getByRole('button', { name: t('twoFactor'), exact: true }).click();
    const disableCode = page.getByLabel(t('totpCode'), { exact: true });
    await page.getByRole('heading', { name: t('totpBoundTitle'), exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: t('startBind'), exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: t('confirmOn'), exact: true }).count(), 0);
    const disable = page.locator('.key-actions').getByRole('button', { name: t('unbindTotp'), exact: true });
    await disableCode.fill(String((Number(totp(totpSecret)) + 1) % 1000000).padStart(6, '0'));
    const failedDisable = page.waitForResponse(r => new URL(r.url()).origin === origins.api && new URL(r.url()).pathname === '/api/self/totp/disable' && r.request().method() === 'POST');
    await disable.click();
    assert.equal((await failedDisable).status(), 400);
    await page.getByRole('alert').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('rsrs.userToken')), userToken);
    assert.equal((await call('/api/self/keys', { token: userToken })).totp, true);
    await disableCode.fill(totp(totpSecret));
    await responseFor('/api/self/totp/disable', () => disable.click());
    assert.equal((await call('/api/self/keys', { token: userToken })).totp, false);
    assert.equal(await page.evaluate(() => localStorage.getItem('rsrs.userToken')), userToken);
    await page.locator('.security-overview h2').getByText(t('totpOffH2'), { exact: true }).waitFor();
    await page.reload();
    assert.equal(await page.evaluate(() => localStorage.getItem('rsrs.userToken')), userToken);
    await page.locator('.settings-panel').getByText(t('totpOff'), { exact: true }).waitFor();
    await page.getByText(t('verified'), { exact: true }).waitFor();
  });
  await step('user-password-change-and-session-relogin', async () => {
    await page.locator('.security-tabs').getByRole('button', { name: t('loginPassH3'), exact: true }).click();
    await page.getByLabel(t('newLoginPassword'), { exact: true }).fill(nextPassword);
    await page.getByLabel(t('confirmNewPass'), { exact: true }).fill(nextPassword);
    await responseFor('/api/self/password', () => page.getByRole('button', { name: t('updatePass'), exact: true }).click());
    await page.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
    await page.getByLabel(t('username'), { exact: true }).fill(user);
    await page.getByLabel(t('loginPassword'), { exact: true }).fill(nextPassword);
    await page.getByLabel(t('superOptional'), { exact: true }).fill(recovery);
    await page.locator('.gate-form form').getByRole('button', { name: t('login'), exact: true }).click();
    await page.locator('.console-main').waitFor();
    userToken = await page.evaluate(() => localStorage.getItem('rsrs.userToken'));
    assert.ok(userToken);
  });
  await step('user-email-password-recovery', async () => {
    const previousToken = userToken;
    const vault = await call('/api/self/vault', { token: previousToken });
    const recoveredPassword = randomBytes(20).toString('hex');
    await page.locator('.sidebar-bottom').getByRole('button', { name: t('signOut'), exact: true }).click();
    await page.getByRole('button', { name: t('forgotPassword'), exact: true }).click();
    await page.getByLabel(t('username'), { exact: true }).fill(user);
    const requestedAt = new Date().toISOString();
    await responseFor('/forgot', () => page.getByRole('button', { name: t('sendCode'), exact: true }).click());
    const code = await receivedCode('reset_password', requestedAt);
    await page.getByLabel(t('emailCode'), { exact: true }).fill(code);
    await page.getByLabel(t('newLoginPassword'), { exact: true }).fill(recoveredPassword);
    await page.getByLabel(t('confirmLoginPassword'), { exact: true }).fill(recoveredPassword);
    await responseFor('/reset', () => page.getByRole('button', { name: t('resetPassword'), exact: true }).click());
    await call('/api/self', { token: previousToken, expected: 401 });
    const previous = await authPayload(user, nextPassword);
    await call('/login', { method: 'POST', body: previous, expected: 401 });
    const recovered = await authPayload(user, recoveredPassword);
    await call('/reset', { method: 'POST', body: { ...recovered, code }, expected: 401 });
    await page.getByLabel(t('username'), { exact: true }).fill(user);
    await page.getByLabel(t('loginPassword'), { exact: true }).fill(recoveredPassword);
    await page.getByLabel(t('superOptional'), { exact: true }).fill(recovery);
    await page.locator('.gate-form form').getByRole('button', { name: t('login'), exact: true }).click();
    await page.locator('.console-main').waitFor();
    userToken = await page.evaluate(() => localStorage.getItem('rsrs.userToken'));
    assert.deepEqual(await call('/api/self/vault', { token: userToken }), vault);
    assert.equal((await call('/api/self/keys', { token: userToken })).email_verified, true);
    await page.getByText(t('verified'), { exact: true }).waitFor();
    await screenshot('user-password-recovered');
  });
  await step('admin-fixture-owner-and-viewer-permissions', async () => {
    for (const [name, pass, role] of [[owner, ownerPassword, 'owner'], [viewer, viewerPassword, 'viewer']]) {
      const auth = await authPayload(name, pass);
      await call('/admin/admins', { method: 'POST', token: adminToken, body: { ...auth, role, email: `${name}@example.invalid` } });
      created.add(name);
    }
    const auth = await authPayload(viewer, viewerPassword);
    const identity = await call('/admin/login', { method: 'POST', body: { user: viewer, pass_hash: auth.pass_hash } });
    viewerToken = identity.token;
    await call('/admin/users', { token: identity.token });
    await call('/admin/admins', { token: identity.token, expected: 403 });
    await call('/admin/outbox', { token: identity.token, expected: 403 });
    await call('/admin/stats', { token: identity.token, expected: 403 });
    await call('/admin/stats', { expected: 401 });
    await call('/admin/admins', { method: 'POST', token: identity.token, body: {}, expected: 403 });
  });
  await step('admin-password-login-and-all-real-views', async () => {
    await page.goto(`${origins.admin}/`);
    await page.getByLabel(t('username'), { exact: true }).fill(owner);
    await page.getByLabel(t('loginPassword'), { exact: true }).fill(ownerPassword);
    await page.locator('.gate-form form').getByRole('button', { name: t('login'), exact: true }).click();
    await page.locator('.console-main').waitFor();
    ownerToken = await page.evaluate(() => localStorage.getItem('rsrs.adminToken'));
    assert.ok(ownerToken);
    await page.reload();
    await page.locator('.console-main').waitFor();
    for (const id of ['users', 'admins', 'audit', 'mail', 'security']) {
      await navigate(id);
      await page.locator('.page-heading h1').waitFor();
      if (id === 'admins') {
        await page.locator('.user-cell').getByText(owner, { exact: true }).waitFor();
        await page.locator('.user-cell').getByText(viewer, { exact: true }).waitFor();
      }
      await screenshot(`admin-${id}`);
    }
    await navigate('users');
    await page.getByLabel(t('searchUser'), { exact: true }).fill(user);
    await page.getByLabel(t('searchUser'), { exact: true }).press('Enter');
    await page.locator('.user-cell').filter({ hasText: user }).click();
    await page.getByRole('dialog', { name: t('userDetail') }).waitFor();
    await screenshot('admin-user-detail');
    await page.getByRole('button', { name: t('close'), exact: true }).click();
  });
  await step('admin-daily-stats-ranges-history-and-responsive-readback', async () => {
    for (const days of [7, 30, 90]) {
      const stats = await call(`/admin/stats?days=${days}`, { token: ownerToken });
      assert.equal(stats.days, days);
      assert.equal(stats.timezone, 'Asia/Shanghai');
      assert.equal(stats.historical_baseline, 'retained_registrations_and_sessions');
      assert.match(stats.memory_tracking_since, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(stats.series.length, days);
      assert.ok(stats.series.every((point, i) => {
        return (!i || stats.series[i - 1].date < point.date)
          && Number.isInteger(point.registrations) && point.registrations >= 0
          && Number.isInteger(point.sessions) && point.sessions >= 0
          && (point.date < stats.memory_tracking_since ? point.memories === null : Number.isInteger(point.memories) && point.memories >= 0);
      }));
    }
    for (const days of ['6', '91', 'abc']) await call(`/admin/stats?days=${days}`, { token: ownerToken, expected: 400 });
    await navigate('stats');
    await page.locator('.stats-panel .uplot').waitFor();
    const stats = await call('/admin/stats', { token: ownerToken });
    await page.getByText(t('statsHistory', { date: stats.memory_tracking_since }), { exact: true }).waitFor();
    for (const days of [7, 90, 30]) {
      const reply = page.waitForResponse(r => new URL(r.url()).origin === origins.api && new URL(r.url()).pathname === '/admin/stats' && new URL(r.url()).search === `?days=${days}`);
      await page.getByRole('button', { name: t('statsDays', { n: days }), exact: true }).click();
      assert.equal((await reply).status(), 200);
      await page.locator('.stats-panel .uplot').waitFor();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => {
      const plot = document.querySelector('.stats-panel .uplot');
      return plot && plot.getBoundingClientRect().width <= plot.parentElement.clientWidth + 1;
    });
    await screenshot('admin-stats-mobile');
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('rsrs.adminToken')), ownerToken);
    await screenshot('admin-stats');
  });
  await step('admin-owner-totp-and-auth-boundaries', async () => {
    await navigate('security');
    await page.locator('.security-tabs').getByRole('button', { name: t('twoFactor'), exact: true }).click();
    await page.getByRole('button', { name: t('startBind'), exact: true }).click();
    await page.locator('.setup-key code').waitFor();
    const secret = await page.locator('.setup-key code').textContent();
    await page.getByLabel(t('totpCode'), { exact: true }).fill(totp(secret));
    await responseFor('/admin/totp/confirm', () => page.getByRole('button', { name: t('confirmOn'), exact: true }).click());
    const auth = await authPayload(owner, ownerPassword);
    const challenge = await call('/admin/login', { method: 'POST', body: { user: owner, pass_hash: auth.pass_hash } });
    assert.equal(challenge.totp_required, true);
    await call('/admin/login/totp', { method: 'POST', body: { ticket: challenge.ticket, code: 'invalid-code' }, expected: 401 });
    const nextChallenge = await call('/admin/login', { method: 'POST', body: { user: owner, pass_hash: auth.pass_hash } });
    const result = await call('/admin/login/totp', { method: 'POST', body: { ticket: nextChallenge.ticket, code: totp(secret) } });
    assert.ok(result.token);
    // Successful challenged login replaces the admin token; use it for fixture teardown.
    ownerToken = result.token;
    await call('/admin/totp/disable', { method: 'POST', token: ownerToken, body: { code: totp(secret) } });
    await call('/api/self', { expected: 401 });
    await call('/admin/me', { expected: 401 });
    await call('/admin/me', { token: userToken, expected: 403 });
    await call('/api/self', { token: adminToken, expected: 401 });
  });
} catch (error) {
  fatal = true;
  const sourceLines = [...String(error.stack || '').matchAll(/browser-hosted-split-smoke\.mjs:(\d+):\d+/g)].slice(0, 3).map(match => Number(match[1]));
  // Do not record arbitrary URL paths or query strings that might contain secrets.
  const surface = Object.entries(origins).find(([, value]) => value === new URL(page?.url() || 'about:blank').origin)?.[0] || 'unknown';
  let failureScreenshot = false;
  try {
    await screenshot('failure-masked');
    failureScreenshot = true;
  } catch {
    // Preserve the original failure without dumping credential-bearing browser state.
  }
  rows.push({ name: current, status: 'fail', error_type: error instanceof assert.AssertionError ? 'AssertionError' : 'Error', source_lines: sourceLines, surface, masked_failure_screenshot: failureScreenshot });
  console.error(`FAIL ${current}; detailed credential-bearing error text omitted.`);
} finally {
  // Cleanup only exact identities created by this run; never list/delete arbitrary dev accounts.
  for (const [name, path] of [[user, 'users'], [viewer, 'admins'], [owner, 'admins']]) {
    if (!created.has(name)) continue;
    try {
      const revoked = await call(`/admin/${path}/${encodeURIComponent(name)}/revoke`, { method: 'POST', token: adminToken, body: {} });
      if (path === 'users') {
        assert.equal(revoked.purged, true, 'Owned user fixture was not purged');
        if (userToken) await call('/api/self', { token: userToken, expected: 401 });
        const remaining = await call(`/admin/users?q=${encodeURIComponent(name)}`, { token: adminToken });
        assert.ok(Array.isArray(remaining.users), 'User-list proof lacks its required collection');
        assert.ok(!remaining.users.some(identity => identity.user === name), 'Purged owned user remains in the user list');
      } else {
        assert.equal(revoked.deleted, true, 'Owned admin fixture was not deleted');
        const priorToken = name === owner ? ownerToken : viewerToken;
        if (priorToken) await call('/admin/me', { token: priorToken, expected: 403 });
        const remaining = await call('/admin/admins', { token: adminToken });
        assert.ok(Array.isArray(remaining.admins), 'Admin-list proof lacks its required collection');
        assert.ok(!remaining.admins.some(identity => identity.user === name), 'Deleted owned admin remains in the admin list');
      }
      rows.push({ name: `cleanup-${path}-fixture`, status: 'pass' });
    } catch {
      fatal = true;
      rows.push({ name: `cleanup-${path}-fixture`, status: 'fail' });
    }
  }
  browserGuard?.beginClosing();
  try { await context?.close(); } catch { fatal = true; }
  try { await browser?.close(); } catch { fatal = true; }
  if (networkFailures.length || runtimeErrors) fatal = true;
  await writeFile(resolve(output, 'result.json'), JSON.stringify({
    server_sha: expectedSha, site_sha: siteSha, origins, passed: !fatal,
    checks: rows, browser_runtime_error_count: runtimeErrors, network_guard_violations: [...new Set(networkFailures)],
    fixture_names: { user, owner, viewer },
    screenshot_secrets_masked: true, screenshots_are_synthetic_test_only: true,
  }, null, 2), { mode: 0o600 });
  console.log(`RESULT_DIR ${output}`);
  if (fatal) process.exitCode = 1;
}
}

// Never dump Playwright/child-process exceptions: they may contain tokens,
// passwords, recovery keys, request bodies, or mailbox command arguments.
main().catch(() => {
  console.error('FAIL hosted split smoke setup or teardown; sensitive error details omitted. Check HOSTED-SPLIT-SMOKE.md prerequisites and approval variables.');
  process.exitCode = 1;
});
