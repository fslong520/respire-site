import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

// Isolated synthetic component coverage. The full compiled dashboard wiring is
// exercised by browser-fixtures.mjs. No account, API or decrypted user data.
const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const origin = server.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true, ...(process.env.RSRS_BROWSER_EXECUTABLE ? { executablePath: process.env.RSRS_BROWSER_EXECUTABLE } : {}) });
const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' });
const errors = [], denied = [];
await context.route('**/*', route => {
  if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
  denied.push(route.request().url()); return route.abort();
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const nodes = n => Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(5, '0'), parent_id: i ? String(i - 1).padStart(5, '0') : '', title: `Synthetic ${i}`, importance: 'important', kind: 'context' }));
const transform = () => page.locator('.memory-graph svg > g').getAttribute('transform');
async function settled() {
  // Wait for actual simulation completion, not a runner-dependent frame rate.
  await page.waitForTimeout(100);
  await page.locator('.memory-graph svg[aria-busy="false"]').waitFor({ timeout: 15000 });
  const before = await page.locator('.memory-graph svg').innerHTML();
  await page.waitForTimeout(250);
  assert.ok(await page.locator('.memory-graph svg').innerHTML() === before, 'Settled simulation must stop');
}
try {
  await page.goto(`${origin}tests/graph-harness.html`);
  await page.locator('.graph-empty').waitFor();
  await page.evaluate(items => window.setGraph(items), nodes(4));
  await page.locator('.graph-node').first().waitFor();
  await settled();
  // Empty -> nonempty must install wheel and resize listeners under StrictMode.
  const svg = page.locator('.memory-graph svg');
  const beforeWheel = await transform();
  await svg.hover(); await page.mouse.wheel(0, -100);
  await page.waitForTimeout(50);
  assert.notEqual(await transform(), beforeWheel);
  const cancelPan = async type => {
    const rect = await svg.boundingBox();
    await page.mouse.move(rect.x + 2, rect.y + 2); await page.mouse.down();
    await svg.dispatchEvent(type, { pointerId: 1 });
    const before = await transform();
    await svg.dispatchEvent('pointermove', { pointerId: 1, clientX: 200, clientY: 100, buttons: 0 });
    assert.equal(await transform(), before);
    await page.mouse.up();
  };
  await cancelPan('pointercancel'); await cancelPan('lostpointercapture');
  const node = page.locator('[data-node="00000"]');
  await node.focus(); await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.opened), ['00000']);
  const point = await node.boundingBox();
  await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2); await page.mouse.down();
  await svg.dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => window.opened), ['00000']);
  // Large input is bounded, paginated, and stable across reordered polls.
  const started = performance.now();
  await page.evaluate(items => window.setGraph(items), nodes(10000));
  await page.getByRole('status').filter({ hasText: 'of 10000' }).waitFor();
  await settled();
  assert.equal(await page.locator('.graph-node').count(), 300);
  console.log(JSON.stringify({ synthetic_nodes: 10000, svg_nodes: 300, elapsed_ms: Math.round(performance.now() - started) }));
  const ids = await page.locator('.graph-node').evaluateAll(es => es.map(e => e.dataset.node));
  const beforePoll = await svg.innerHTML();
  await page.evaluate(items => window.setGraph(items), nodes(10000).reverse());
  await page.waitForTimeout(150);
  assert.deepEqual(await page.locator('.graph-node').evaluateAll(es => es.map(e => e.dataset.node)), ids);
  assert.ok(await svg.innerHTML() === beforePoll, 'Equivalent polling snapshots must not reheat');
  await page.locator('[data-node="00299"]').focus();
  await page.locator('.graph-external summary').click();
  await page.locator('.graph-external button').filter({ hasText: 'Synthetic 300' }).click();
  assert.equal((await page.evaluate(() => window.opened)).at(-1), '00300');
  await page.getByRole('button', { name: 'Next graph page', exact: true }).click();
  await page.locator('[data-node="00300"]').waitFor();
  assert.equal(await page.locator('.graph-node').count(), 300);
  await settled();
  await page.evaluate(() => window.graphLocale('zh'));
  await page.getByRole('status').filter({ hasText: '共 10000 条' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(80);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile graph must not overflow');
  const visible = await page.locator('.graph-node').evaluateAll(es => es.some(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
  assert.ok(visible, 'Auto-fit must retain visible nodes after resize');
  // Touch/keyboard-accessible relation picker and shrinking-snapshot clamp.
  const star = nodes(400).map((n, i) => ({ ...n, parent_id: i ? '00000' : '' }));
  await page.evaluate(items => { window.graphLocale('en'); window.setGraph(items); }, star);
  await page.getByRole('button', { name: 'Previous graph page', exact: true }).click();
  const picker = page.getByLabel('Cross-page relations for', { exact: true });
  await picker.selectOption('00000');
  await page.locator('.graph-external summary').click();
  await page.locator('.graph-external').getByRole('button', { name: 'Next graph page', exact: true }).click();
  await page.evaluate(items => window.setGraph(items), star.slice(0, 320));
  await page.locator('.graph-external li').first().waitFor();
  assert.equal(await page.locator('.graph-external li').count(), 20);
  await picker.focus(); await page.keyboard.press('Tab');
  assert.equal(await page.locator('.graph-external summary').evaluate(el => el === document.activeElement), true);
  await page.evaluate(() => window.setGraph([{ id: 'trivial', importance: 'trivial' }]));
  await page.locator('.graph-empty').waitFor();
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.evaluate(items => window.setGraph(items), nodes(1));
  await page.locator('.graph-node').waitFor();
  await settled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  const bounds = await page.locator('.graph-node').boundingBox();
  const viewport = await svg.boundingBox();
  assert.ok(bounds.x + bounds.width / 2 >= viewport.x && bounds.x + bounds.width / 2 <= viewport.x + viewport.width, 'A settled single node must remain centered after resize');
  const beforeAgain = await transform();
  await svg.hover(); await page.mouse.wheel(0, -100); await page.waitForTimeout(80);
  assert.notEqual(await transform(), beforeAgain);
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  console.log('Synthetic graph browser regressions passed.');
} finally { await context.close(); await browser.close(); await server.close(); }
