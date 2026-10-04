import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildProvenance } from "../scripts/build-provenance.mjs";

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
      // Pages path redirects must follow the same explicit console destinations
      // as homepage links. Relative local-preview links retain the static defaults.
      const consoleOrigin = (value, fallback) => {
        if (!value || value.startsWith('/')) return fallback;
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
          throw new Error('Homepage console redirects require an HTTPS origin');
        }
        return url.origin;
      };
      const dashboard = consoleOrigin(process.env.VITE_DASHBOARD_URL, 'https://dash.rsrs.rs');
      const admin = consoleOrigin(process.env.VITE_ADMIN_URL, 'https://admin.rsrs.rs');
      writeFileSync(resolve(OUT, '_redirects'), `/dashboard ${dashboard}/dashboard 302\n/dashboard/* ${dashboard}/dashboard/:splat 302\n/admin ${admin}/admin 302\n/admin/* ${admin}/admin/:splat 302\n`);
      writeFileSync(resolve(OUT, "build-info.json"), JSON.stringify({ ...buildProvenance(ROOT), target: "homepage", base: BASE }, null, 2) + "\n");
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
