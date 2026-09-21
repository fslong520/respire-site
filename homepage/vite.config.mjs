import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = import.meta.dirname;
const OUT = resolve(ROOT, "../site/dist/client");

/// 官网多语言构建：默认语言（en）出在站点根，其余语言出在 /<locale>/。
///
/// 站点由 service/build.rs 扫目录嵌入 1memory-server，按 URL 精确查表返回，
/// 故每个语言必须有各自的 index.html。单页应用在运行时按 location.pathname 选定
/// 词条集，各语言 HTML 只有 lang / title / description 不同；哈希资源为绝对路径，
/// 各语言目录共用同一份。
///
/// 客户端交互预览（public/preview/client.<locale>.html）是 client/tree-ui 的独立
/// 单文件产物，含内嵌 JS/CSS/Logo，不进打包；英文版由 scripts/preview-i18n.mjs
/// 按对照表生成。
const LOCALES = ["en", "zh"];

const HEAD = {
  en: {
    lang: "en",
    title: "1memory — Teach once. Every AI remembers.",
    description:
      "1memory turns your background, preferences, and project experience into one memory tree. Stored locally, end-to-end encrypted, and shared with your AI tools only within the scope you choose.",
  },
  zh: {
    lang: "zh-CN",
    title: "1memory — 你的记忆，随 AI 同行",
    description:
      "1memory 把你的背景、偏好与项目经验整理成一棵记忆树。本地保存，端到端加密，按所选范围接入你的 AI 工具。",
  },
};

/// 把构建产物 index.html 按语言改写头部。占位注释在 homepage/index.html 里。
///
/// hreflang 用相对路径（`/`、`/zh/`）：dev 与生产同源不同域名，绝对地址只对生产
/// 正确，相对路径两边都对，且符合 hreflang 规范（相对当前文档 URL 解析）。
function localize(html, locale) {
  const head = HEAD[locale];
  const alternates = [
    '<link rel="alternate" hreflang="en" href="/" />',
    '<link rel="alternate" hreflang="zh-Hans" href="/zh/" />',
    '<link rel="alternate" hreflang="x-default" href="/" />',
  ].join('\n    ');
  return html
    .replace(/<html lang="[^"]*"/, `<html lang="${head.lang}"`)
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${head.title}</title>`)
    .replace(
      /(<meta name="description" content=")[^"]*(")/,
      `$1${head.description.replace(/"/g, '&quot;')}$2`,
    )
    .replace('<!-- locale:hreflang -->', alternates);
}

/// 生成各语言入口（默认语言原地改写，其余语言另存到子目录）。
function multiLocale() {
  return {
    name: "1memory-multilocale",
    apply: "build",
    closeBundle() {
      const root = resolve(OUT, "index.html");
      const built = readFileSync(root, "utf8");
      writeFileSync(root, localize(built, "en"), "utf8");
      for (const locale of LOCALES.filter((l) => l !== "en")) {
        mkdirSync(resolve(OUT, locale), { recursive: true });
        writeFileSync(resolve(OUT, locale, "index.html"), localize(built, locale), "utf8");
      }
    },
  };
}

export default defineConfig({
  build: {
    outDir: OUT,
    emptyOutDir: true,
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), multiLocale()],
});
