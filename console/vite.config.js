import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  // useRecommendedBuildConfig would force assetsInlineLimit=inline-everything;
  // we manage the build config ourselves so woff2 slices stay separate files.
  plugins: [viteSingleFile({ useRecommendedBuildConfig: false })],
  // Absolute asset URLs: the bundle is served at /admin and /dashboard, and
  // document URLs like /dashboard/memories/<id> would otherwise resolve the
  // relative font references against the wrong directory.
  base: '/',
  esbuild: { jsx: 'automatic' },
  build: {
    // Fonts stay as separate hashed files: the browser fetches only the
    // unicode-range slices it needs, instead of inlining ~6 MB of base64.
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    assetsDir: '',
  },
  rollupOptions: {
    output: { inlineDynamicImports: true },
  },
  server: {
    // Local dev: forward console API calls to respire-server (cargo run -- serve).
    // Bare /admin (and /dashboard) serve the SPA HTML; /admin/<noun>... are API
    // routes and must proxy. Vite matches proxy keys as URL prefixes unless the
    // key starts with '^', in which case it is a RegExp — so anchor API routes.
    proxy: {
      '^/admin/(?!$)': 'http://127.0.0.1:8787',
      '^/(register|api|login|forgot|reset|forget|pull|push)(/|\\?|$)': 'http://127.0.0.1:8787',
    },
  },
});
