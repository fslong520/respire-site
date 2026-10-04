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
test('production output excludes the legacy prototype distribution',()=>{
  assert.ok(read('../vite.config.mjs').includes('publicDir: "assets"'));
});
