import { defineConfig, loadEnv } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isIP } from 'node:net';
import { normalizeApiBase, DEFAULT_API_BASE_URL } from './src/config.js';
import { buildProvenance } from '../scripts/build-provenance.mjs';

export default defineConfig(({ mode }) => {
  if (!['dashboard', 'admin'].includes(mode)) throw new Error('Use an explicit dashboard or admin mode');
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiBase = normalizeApiBase(env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL);
  const homepageUrl = normalizeApiBase(env.VITE_HOMEPAGE_URL || 'https://rsrs.rs');
  const apiOrigin = new URL(apiBase);
  const apiHostname = apiOrigin.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (process.env.CF_PAGES && (apiOrigin.protocol !== 'https:' || isIP(apiHostname) || apiHostname === 'localhost' || apiHostname.endsWith('.localhost'))) {
    throw new Error('Pages builds require a remote HTTPS API hostname; literal IPs and loopback are for local fixtures only');
  }
  if (process.env.CF_PAGES && process.env.CF_PAGES_BRANCH !== 'main' && apiBase === DEFAULT_API_BASE_URL) {
    throw new Error('Pages previews require an explicit isolated VITE_API_BASE_URL; do not use the production API');
  }
  let outDir = resolve('dist', mode);
  const provenance = {
    name: 'respire-console-provenance',
    apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    closeBundle() {
      const source = JSON.parse(readFileSync(new URL('./upstream.json', import.meta.url), 'utf8'));
      const checkout = buildProvenance(process.cwd());
      mkdirSync(outDir, { recursive: true });
      mkdirSync(resolve(outDir, 'licenses'), { recursive: true });
      for (const name of ['LICENSE', 'COMMERCIAL-LICENSE.md']) copyFileSync(resolve('..', name), resolve(outDir, 'licenses', name));
      for (const name of ['react', 'react-dom', 'scheduler', '@phosphor-icons/react']) {
        copyFileSync(resolve('node_modules', name, 'LICENSE'), resolve(outDir, 'licenses', `${name.replace(/[@/]/g, '-')}.LICENSE`));
      }
      copyFileSync(resolve('upstream.json'), resolve(outDir, 'source-notice.json'));
      writeFileSync(resolve(outDir, 'build-info.json'), `${JSON.stringify({
        ...checkout, target: mode, api_base_url: apiBase, homepage_url: homepageUrl,
        imported_from: source.repository, imported_revision: source.commit,
      }, null, 2)}\n`);
    },
  };
  return {
    plugins: [viteSingleFile(), provenance],
    base: '/',
    publicDir: 'public',
    define: {
      'import.meta.env.VITE_CONSOLE_TARGET': JSON.stringify(mode),
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(apiBase),
      'import.meta.env.VITE_HOMEPAGE_URL': JSON.stringify(homepageUrl),
    },
    esbuild: { jsx: 'automatic' },
    build: { outDir, emptyOutDir: true, assetsInlineLimit: 100000, cssCodeSplit: false },
  };
});
