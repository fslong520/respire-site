// Validate translation keys, nonempty strings, and preview coverage.
//
// Missing translation keys otherwise appear as visible key names.
// Run these checks with node --test tests/i18n.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import zh from '../src/i18n/zh.js';
import en from '../src/i18n/en.js';
import { LOCALES, DEFAULT_LOCALE, localeFromPath, localePrefix } from '../src/i18n/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('en 与 zh 键集完全一致', () => {
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  const onlyZh = zhKeys.filter((k) => !(k in en));
  const onlyEn = enKeys.filter((k) => !(k in zh));
  assert.deepEqual(onlyZh, [], `en 缺少这些键：${onlyZh.join(', ')}`);
  assert.deepEqual(onlyEn, [], `zh 缺少这些键：${onlyEn.join(', ')}`);
  assert.deepEqual(enKeys, zhKeys);
});

test('无空词条', () => {
  for (const [name, dict] of [['zh', zh], ['en', en]]) {
    const empty = Object.entries(dict).filter(([, v]) => typeof v !== 'string' || v.trim() === '');
    assert.deepEqual(empty, [], `${name} 有空词条`);
  }
});

test('英文词条不含中文（专有名词除外）', () => {
  const allowed = new Set(['lang.other']); // The language switch displays the native language name.
  const cjk = /[\u4e00-\u9fff]/;
  const bad = Object.entries(en)
    .filter(([k, v]) => !allowed.has(k) && cjk.test(v))
    .map(([k, v]) => `${k}=${v}`);
  assert.deepEqual(bad, [], `英文词条含中文：${bad.join(' | ')}`);
});

test('语言前缀解析与 URL 策略一致', () => {
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.deepEqual(LOCALES, ['en', 'zh']);
  assert.equal(localePrefix('en'), '');
  assert.equal(localePrefix('zh'), '/zh/');
  assert.equal(localeFromPath('/'), 'en');
  assert.equal(localeFromPath('/index.html'), 'en');
  assert.equal(localeFromPath('/zh/'), 'zh');
  assert.equal(localeFromPath('/zh/index.html'), 'zh');
  assert.equal(localeFromPath('/dashboard'), 'en');
});

test('预览对照表覆盖预览产物全部中文串', () => {
  const dictPath = resolve(root, 'i18n/preview.en.json');
  assert.ok(existsSync(dictPath), '缺 i18n/preview.en.json');
  const dict = JSON.parse(readFileSync(dictPath, 'utf8'));
  const src = readFileSync(resolve(root, 'public/preview/client.zh.html'), 'utf8');
  const cjk = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

  // Inspect Chinese strings with the same extraction rules as preview-i18n.mjs.
  const bodies = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(src))) bodies.push(m[1]);
  const zhInHtml = new Set();
  for (const body of bodies) {
    for (const hit of body.matchAll(/[\u4e00-\u9fff]+/g)) {
      if (cjk.test(hit[0])) zhInHtml.add(hit[0]);
    }
  }
  const keys = new Set(Object.keys(dict));
  // Require a nonempty dictionary covering the extracted string fragments.
  const uncovered = [...zhInHtml].filter((frag) => ![...keys].some((k) => k.includes(frag)));
  assert.ok(keys.size > 400, `对照表条目过少：${keys.size}`);
  assert.ok(
    uncovered.length / zhInHtml.size < 0.05,
    `对照表未覆盖的片段过多（${uncovered.length}/${zhInHtml.size}）：${uncovered.slice(0, 20).join(' / ')}`,
  );
});
