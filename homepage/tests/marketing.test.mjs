import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=(path)=>readFileSync(new URL(path,import.meta.url),'utf8');
test('marketing routes use production portals, not prototype account screens',()=>{
  const app=read('../src/App.tsx');
  const destinations=read('../src/destinations.ts');
  assert.ok(destinations.includes('https://dash.rsrs.rs'));
  assert.ok(destinations.includes('https://admin.rsrs.rs'));
  assert.ok(app.includes('href={DASHBOARD_URL}'));
  assert.doesNotMatch(app,/href="\/(?:dashboard|admin)/);
  assert.doesNotMatch(app,/DESIGN PREVIEW|No live services|useDemoState/);
});
test('installation and product guidance describe the supported CLI',()=>{
  const details=read('../src/respire/product-details.tsx');
  assert.ok(details.includes('npm i -g @rsrsai/cli'));
  assert.ok(details.includes('pnpm add -g @rsrsai/cli'));
  assert.ok(details.includes('rsrs doctor'));
  assert.doesNotMatch(details,/proprietary|open source|product brief|hospital deployment/i);
});
test('the AI install prompt card is ported with its prompt verbatim',()=>{
  const card=read('../src/respire/ai-install.tsx');
  const details=read('../src/respire/product-details.tsx');
  const styles=read('../src/styles.css');
  for(const step of [
    'npm i -g @rsrsai/cli',
    'rsrs doctor --fix',
    'rsrs register',
    'rsrs inject --all',
    'rsrs remember "安装测试条目" && rsrs sync && rsrs recall "安装测试条目" --titles',
    'rsrs doctor --remote（fail 必须是 0，Remote 要 PASS）',
    '干净环境实测通过 · 直连 rsrs 云',
  ])assert.ok(card.includes(step),'prompt step missing: '+step);
  assert.ok(details.includes('<AiInstallCard lang={lang}/>'));
  assert.ok(card.includes('navigator.clipboard.writeText'));
  assert.ok(card.includes('document.execCommand'));
  assert.match(card,/'idle' \| 'copied' \| 'manual'/);
  assert.ok(styles.includes('.prompt-card{'));
});
test('production output copies the current website assets',()=>{
  assert.ok(read('../vite.config.mjs').includes('publicDir: "assets"'));
});

test('public build metadata is generated from the checkout, not a hard-coded revision',()=>{
  const config=read('../vite.config.mjs');
  assert.ok(config.includes('buildProvenance(ROOT)'));
  assert.ok(config.includes('"build-info.json"'));
  assert.ok(config.includes('target: "homepage"'));
});
