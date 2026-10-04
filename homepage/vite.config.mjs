import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = import.meta.dirname;
const OUT = resolve(ROOT, process.env.VITE_SITE_OUT_DIR || "../site/dist/client");
const BASE = process.env.VITE_SITE_BASE || "/";
if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(BASE)) throw new Error("Invalid website base path");

/// Build the default language at / and other languages at /<locale>/.
///
/// Deployment serves the generated static files by URL.
/// Each language needs an index.html; the client selects strings from the URL.
/// Localized pages differ in language, title, and description.
/// All language entries share the same hashed assets.
///
/// public/preview/client.<locale>.html is a standalone client preview.
/// It is copied unchanged; preview-i18n.mjs generates its English translation.
/// The translation dictionary is stored in i18n/preview.en.json.
const LOCALES = ["en", "zh"];

const HEAD = {
  en: {
    lang: "en",
    title: "Respire — Memory as natural as breathing",
    description:
      "A local-first memory layer for the way you think. Carry useful context across your AI tools and sessions.",
  },
  zh: {
    lang: "zh-CN",
    title: "Respire — 你的记忆，随 AI 同行",
    description:
      "Respire 把你的背景、偏好与项目经验整理成一棵记忆树。本地保存，端到端加密，按所选范围接入你的 AI 工具。",
  },
};

/// Localize the generated index.html head using its hreflang placeholder.
///
/// Use relative alternate-language links across development and production.
/// Links resolve against the current document origin.
function localize(html, locale) {
  const head = HEAD[locale];
  const alternates = [
    `<link rel="alternate" hreflang="en" href="${BASE}" />`,
    `<link rel="alternate" hreflang="zh-Hans" href="${BASE}zh/" />`,
    `<link rel="alternate" hreflang="x-default" href="${BASE}" />`,
  ].join('\n    ');
  return html
    .replace(/<html lang="[^"]*"/, `<html lang="${head.lang}"`)
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${head.title}</title>`)
    .replace(
      /(<meta name="description" content=")[^"]*(")/,
      `$1${head.description.replace(/"/g, '&quot;')}$2`,
    )
    .replace('<!-- locale:hreflang -->', `<link rel="canonical" href="https://rsrs.rs${locale === 'en' ? '/' : '/zh/'}" />\n    ${alternates}`);
}

/// Write the default entry in place and other entries in locale directories.
function multiLocale() {
  return {
    name: "respire-multilocale",
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
  base: BASE,
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
  publicDir: "assets",
  plugins: [react(), tailwindcss(), multiLocale()],
});
