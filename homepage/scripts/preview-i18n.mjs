// Extract Chinese strings from public/preview/client.zh.html.
// Generate public/preview/client.en.html using i18n/preview.en.json.
//
// The preview is a standalone client bundle with embedded scripts and styles.
// Translate this checked-in preview without rebuilding its separate application.
//
// Translation keys are decoded strings, including literal newlines and quotes.
// Output is escaped for its JavaScript string or template context.
//
// Usage:
// node scripts/preview-i18n.mjs --extract   List missing translations in .tmp-preview-missing.json.
// node scripts/preview-i18n.mjs             Generate and validate the English preview.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'public/preview/client.zh.html');
const DICT = path.join(root, 'i18n/preview.en.json');
const OUT = path.join(root, 'public/preview/client.en.html');

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function walk(node, cb) {
  cb(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') walk(c, cb);
    } else if (v && typeof v.type === 'string') walk(v, cb);
  }
}

/// Collect Chinese string fragments from a script body at the supplied base offset.
/// Collect complete literals and individual template elements.
function collect(body, base, out) {
  const ast = acorn.parse(body, { ecmaVersion: 'latest', sourceType: 'script' });
  walk(ast, node => {
    if (node.type === 'Literal' && typeof node.value === 'string') {
      if (CJK.test(node.value)) {
        out.push({ start: base + node.start + 1, end: base + node.end - 1, kind: 'string', text: node.value });
      }
      return;
    }
    if (node.type === 'TemplateElement') {
      const cooked = node.value.cooked;
      if (typeof cooked !== 'string' || !CJK.test(cooked)) return;
      // Trim template delimiters to locate the raw text span.
      let start = node.start;
      let end = node.end;
      if (body[start] === '`') start++;
      else if (body.startsWith('${', start)) start += 2;
      if (body[end - 1] === '`') end--;
      else if (body[end - 1] === '}') end--;
      out.push({ start: base + start, end: base + end, kind: 'template', text: cooked });
    }
  });
}

function encodeJs(text, kind) {
  let out = text.replace(/\\/g, '\\\\');
  out = out.replace(/\r\n/g, '\\n').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  out = out.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  if (kind === 'template') out = out.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return out;
}

const html = fs.readFileSync(SRC, 'utf8');
const scripts = [];
{
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    scripts.push({ bodyStart, body: m[1] });
  }
}

const spans = [];
for (const s of scripts) collect(s.body, s.bodyStart, spans);
spans.sort((a, b) => a.start - b.start);

const found = new Map(); // Text -> occurrence count.
for (const span of spans) found.set(span.text, (found.get(span.text) || 0) + 1);

const headHtml = html.slice(0, scripts[0]?.bodyStart ?? 0);
const headZh = {
  title: /<title>([^<]*)<\/title>/.exec(headHtml)?.[1] ?? '',
  description: /<meta name="description" content="([^"]*)"/.exec(headHtml)?.[1] ?? '',
};

const dict = fs.existsSync(DICT) ? JSON.parse(fs.readFileSync(DICT, 'utf8')) : {};
const missing = [...found.keys()].filter(k => !(k in dict));

if (process.argv.includes('--extract')) {
  // Write UTF-8 to a file to avoid terminal redirection encoding changes.
  fs.writeFileSync(path.join(root, '.tmp-preview-missing.json'), JSON.stringify(missing, null, 1), 'utf8');
  console.log(`# 待译文本：${found.size} 条（去重，共 ${spans.length} 处）；已译 ${found.size - missing.length}，缺译 ${missing.length}`);
  console.log('# 缺译清单 -> homepage/.tmp-preview-missing.json');
  console.log(`# 头部中文 -> ${JSON.stringify(Object.values(headZh))}`);
  process.exit(0);
}

if (missing.length) {
  console.error(`缺译 ${missing.length} 条，先补 i18n/preview.en.json`);
  process.exit(1);
}
for (const key of ['@html.title', '@html.description']) {
  if (!dict[key]) {
    console.error(`i18n/preview.en.json 缺 ${key}`);
    process.exit(1);
  }
}

// Replace spans in reverse order to preserve offsets.
let out = html;
let replaced = 0;
for (const span of [...spans].reverse()) {
  out = out.slice(0, span.start) + encodeJs(dict[span.text], span.kind) + out.slice(span.end);
  replaced++;
}

out = out.replace(/<html lang="[^"]*"/, '<html lang="en"');
out = out.replace(/<title>[^<]*<\/title>/, `<title>${dict['@html.title']}</title>`);
out = out.replace(
  /(<meta name="description" content=")[^"]*(")/,
  `$1${dict['@html.description'].replace(/"/g, '&quot;')}$2`,
);

// Require every generated script to parse successfully.
{
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  let i = 0;
  while ((m = re.exec(out))) {
    try {
      acorn.parse(m[1], { ecmaVersion: 'latest', sourceType: 'script' });
    } catch (e) {
      console.error(`产物第 ${i} 个 script 语法校验失败：${e.message}`);
      process.exit(1);
    }
    i++;
  }
  console.log(`script 语法校验：${i} 个全通过`);
}

fs.writeFileSync(OUT, out, 'utf8');
const leftover = [...out.matchAll(/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]+/g)].map(m => m[0]);
const uniq = [...new Set(leftover)];
console.log(`已写出 ${path.relative(root, OUT)}（替换 ${replaced} 处，${out.length} 字节；中文原 ${html.length}）`);
console.log(`残留中文：${leftover.length} 处 / ${uniq.length} 种`);
if (uniq.length) {
  fs.writeFileSync(path.join(root, '.tmp-preview-leftover.json'), JSON.stringify(uniq, null, 1), 'utf8');
  // Reject untranslated Chinese strings in the English preview.
  console.error('残留清单 -> homepage/.tmp-preview-leftover.json');
  console.error('对照表未覆盖上述文本，请补 i18n/preview.en.json 后重跑。');
  process.exit(1);
}
