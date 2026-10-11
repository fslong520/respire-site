// 从 homepage/src/client-preview.html（中文版客户端交互预览产物）抽取中文文本，
// 按 homepage/i18n/preview.en.json 对照表生成英文版 src/client-preview.en.html。
//
// 该产物是 client/tree-ui 的单文件构建（内嵌 JS/CSS/Logo），且已领先源码若干版，
// 故不重构建，只做文本对照替换。
//
// 对照表以「解码后的文本」为键（真实换行、真实引号），值为英文文本；写入时按所在
// 上下文重新转义，故译文里写真实换行、真实引号即可，不必手写 \n、\'。
//
// 用法：
//   node scripts/preview-i18n.mjs --extract   列出待译文本（写 .tmp-preview-missing.json）
//   node scripts/preview-i18n.mjs             生成 src/client-preview.en.html 并校验
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

/// 收集单个 script 体（body，基准偏移 base）内所有含中文的字符串片段：
/// 普通字符串取字面量整体，模板串按插值切段。
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
      // 模板元素范围含两侧的反引号 / `${` 与 `}`，按 raw 头尾裁出纯文本
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

const found = new Map(); // 文本 -> 出现次数
for (const span of spans) found.set(span.text, (found.get(span.text) || 0) + 1);

const headHtml = html.slice(0, scripts[0]?.bodyStart ?? 0);
const headZh = {
  title: /<title>([^<]*)<\/title>/.exec(headHtml)?.[1] ?? '',
  description: /<meta name="description" content="([^"]*)"/.exec(headHtml)?.[1] ?? '',
};

const dict = fs.existsSync(DICT) ? JSON.parse(fs.readFileSync(DICT, 'utf8')) : {};
const missing = [...found.keys()].filter(k => !(k in dict));

if (process.argv.includes('--extract')) {
  // Windows 终端重定向按代码页转码，故落文件而非 stdout
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

// 逆序替换，保偏移有效
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

// 语法校验：产物每个 script 须可解析
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
  // 英文产物要发布给访客，残留中文即漏译，必须挡住而非只打印告警
  console.error('残留清单 -> homepage/.tmp-preview-leftover.json');
  console.error('对照表未覆盖上述文本，请补 i18n/preview.en.json 后重跑。');
  process.exit(1);
}
