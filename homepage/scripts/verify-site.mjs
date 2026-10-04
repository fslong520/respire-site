// Serve the built website with its production route layout.
// Render it in headless Chrome and capture visible text and console errors.
//
// Usage: node scripts/verify-site.mjs [--keep].
// Requires site/dist/client from npm run build.
import http from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(root, '../site/dist/client');
const PORT = 5188;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/// Skip hidden files and Cloudflare-specific output.
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name.startsWith('.')) continue;
      collect(p, out);
    } else if (!name.startsWith('.') && name !== '_headers' && name !== 'index.rsc') {
      out.push('/' + p.slice(DIST.length + 1).replace(/\\/g, '/'));
    }
  }
  return out;
}

const assets = new Map(collect(DIST).map((url) => [url, join(DIST, url.slice(1))]));

const server = http.createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const send = (status, body, type) => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
  };
  // Embed the actual preview in an iframe and exercise parent tabs.
  // Check that the preview dock follows the parent tab selection.
  if (path === '/_interaction.html') {
    return send(200, INTERACTION_HARNESS, MIME['.html']);
  }
  // Serve the default language at / and other languages at /<locale>/.
  if (path === '/' || path === '') return send(200, readFileSync(assets.get('/index.html')), MIME['.html']);
  const bare = path.replace(/\/$/, '');
  const localeHtml = assets.get(`${bare}/index.html`);
  if (localeHtml) return send(200, readFileSync(localeHtml), MIME['.html']);
  const file = assets.get(path);
  if (file) return send(200, readFileSync(file), MIME[extname(path)] ?? 'application/octet-stream');
  send(404, 'not found', 'text/plain');
});

/// Load the built site, select a parent tab, and inspect the preview dock.
/// Poll for React readiness across the nested iframe.
const INTERACTION_HARNESS = `<!doctype html><html><body>
<iframe id="site" src="/" width="1300" height="900"></iframe>
<pre id="out">PENDING</pre>
<script>
const out = document.getElementById('out');
const log = [];
const done = () => { out.textContent = log.join(' | '); };
const waitFor = (fn, ms) => new Promise(res => {
  const t0 = Date.now();
  const tick = () => (fn() || Date.now() - t0 > ms) ? res(fn()) : setTimeout(tick, 200);
  tick();
});
document.getElementById('site').onload = async () => {
  const site = document.getElementById('site').contentDocument;
  const preview = await waitFor(() => [...site.querySelectorAll('iframe')].find(f => (f.getAttribute('src') || '').includes('preview/')), 8000);
  if (!preview) { log.push('RESULT=NO-PREVIEW'); return done(); }
  log.push('PREVIEW=' + preview.getAttribute('src'));
  const dock = () => [...preview.contentDocument.querySelectorAll('.dock button')];
  const active = () => dock().filter(b => b.classList.contains('active')).map(b => b.textContent.trim()).join(',');
  await waitFor(() => dock().length > 0, 8000);
  log.push('BEFORE=' + active());
  const tab = [...site.querySelectorAll('.mode-tabs button')].find(b => b.textContent.includes('Sync'));
  if (tab) tab.click();
  await new Promise(r => setTimeout(r, 1500));
  log.push('AFTER=' + active());
  log.push(active() === 'Sync' ? 'RESULT=OK' : 'RESULT=FAIL');
  const install = dock().find(b => b.textContent.trim() === 'Install');
  if (install) install.click();
  await new Promise(r => setTimeout(r, 1000));
  const selected = [...site.querySelectorAll('.mode-tabs button')].filter(b => b.getAttribute('aria-selected') === 'true').map(b => b.textContent).join(',');
  log.push('PARENT-TAB=' + selected);
  log.push(/Install/.test(selected) ? 'RESULT-UP=OK' : 'RESULT-UP=FAIL');
  done();
};
<\/script></body></html>`;



const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

/// Render a URL and return visible text, iframe content, and console errors.
/// Allow extra time for React to initialize in nested frames.
function render(url, budget = 8000) {
  return new Promise((done) => {
    const profile = join(process.env.TEMP ?? '.', `respire-verify-${Date.now()}`);
    const child = spawn(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      `--user-data-dir=${profile}`,
      `--virtual-time-budget=${budget}`,
      '--dump-dom',
      url,
    ]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => done({ dom: out, err }));
  });
}

/// Extract visible DOM text without scripts, styles, or markup.
function visibleText(dom) {
  return dom
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`静态服务：http://127.0.0.1:${PORT}（产物 ${assets.size} 个）\n`);

const base = `http://127.0.0.1:${PORT}`;
const en = await render(`${base}/`);
const enText = visibleText(en.dom);
check('英文站渲染出主标题', enText.includes('Your memory'), enText.slice(0, 60));
check('英文站无中文正文', !/[\u4e00-\u9fff]/.test(enText.replace(/中文/g, '')), [...new Set(enText.match(/[\u4e00-\u9fff]+/g) ?? [])].slice(0, 8).join(' / '));
check('英文站 html lang=en', en.dom.includes('<html lang="en"'));
check('英文站嵌入英文预览', en.dom.includes('preview/client.en.html'));

const zh = await render(`${base}/zh/`);
const zhText = visibleText(zh.dom);
check('中文站渲染出主标题', zhText.includes('你的记忆'), zhText.slice(0, 60));
check('中文站 html lang=zh-CN', zh.dom.includes('<html lang="zh-CN"'));
check('中文站嵌入中文预览', zh.dom.includes('preview/client.zh.html'));
check('中文站含语言切换', zhText.includes('English'));

const zhBare = await render(`${base}/zh`);
check('/zh（无斜杠）同样出中文', visibleText(zhBare.dom).includes('你的记忆'));

const enPreview = await render(`${base}/preview/client.en.html`);
const enPreviewText = visibleText(enPreview.dom);
check('英文预览可独立渲染', enPreviewText.length > 500, `${enPreviewText.length} 字符`);
const leftover = [...new Set(enPreviewText.match(/[\u4e00-\u9fff]+/g) ?? [])];
check('英文预览无残留中文', leftover.length === 0, leftover.slice(0, 12).join(' / '));

const zhPreview = await render(`${base}/preview/client.zh.html`);
check('中文预览仍为中文', /[\u4e00-\u9fff]/.test(visibleText(zhPreview.dom)));

// Check parent-to-iframe tab synchronization.
const inter = await render(`${base}/_interaction.html`, 30000);
check('父页标签能带动预览切换', inter.dom.includes('RESULT=OK'), (/(RESULT=[A-Z-]+)/.exec(inter.dom) ?? [''])[0]);
check('预览内点 Dock 能回填父页', inter.dom.includes('RESULT-UP=OK'), (/(RESULT-UP=[A-Z-]+)/.exec(inter.dom) ?? [''])[0]);


for (const [name, r] of [['英文站', en], ['中文站', zh], ['英文预览', enPreview]]) {
  const errors = (r.err.match(/ERROR:[\s\S]*?(?=\n\S|$)/g) ?? []).filter((e) => !/DevTools|GPU|gpu|Fontconfig|voice|Registration/i.test(e));
  check(`${name}无控制台报错`, errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 200));
}

server.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
process.exit(failed.length ? 1 : 0);
