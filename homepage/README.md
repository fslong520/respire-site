# Respire Homepage

React/Vite source for the Respire website. English is served at `/`; Chinese at `/zh/`. The URL selects the language.

| Path | Purpose |
| --- | --- |
| `src/App.tsx` | Header, hero, product sections and portal links |
| `src/respire/product-story.tsx` | Workflow tabs, examples and FAQ |
| `src/respire/product-details.tsx` | CLI installation and usage |
| `src/respire/MemoryFiberScene.tsx` | Three.js artwork, image fallback and motion controls |
| `src/respire/memory-narrative.tsx` | Scroll-linked continuous red strand |
| `src/destinations.ts` | Portal and base-path configuration |
| `assets/` | Original reference artwork and favicon |
| `scripts/verify-marketing.mjs` | Built-page browser checks |

## Development

```sh
npm ci
npm run dev
npm run check
npm test
npm run build
npx playwright install chromium
npm run verify:browser
```

Set `CHROME_PATH` to use an existing Chrome executable instead of the Playwright browser. Set `SITE_SCREENSHOTS` to capture desktop and mobile screenshots during verification.

The browser check exercises English and Chinese rendering, portal links, CLI instructions, FAQ, animation pause, mobile navigation, overflow and reduced motion. Source checks run through `npm test`.

## Production and development preview

| Setting | Production default | Development preview |
| --- | --- | --- |
| `VITE_SITE_BASE` | `/` | `/preview/` |
| `VITE_SITE_OUT_DIR` | `../site/dist/client` | `../site/dist/preview` |
| `VITE_DASHBOARD_URL` | `https://dash.rsrs.rs` | `/dashboard` |
| `VITE_ADMIN_URL` | `https://admin.rsrs.rs` | `/admin` |

`npm run build:dev` applies the preview settings and writes a separate distribution. To verify it:

```sh
VITE_SITE_BASE=/preview/ VITE_SITE_OUT_DIR=../site/dist/preview VITE_DASHBOARD_URL=/dashboard VITE_ADMIN_URL=/admin npm run verify:browser
```

The build copies only `assets/`, so the legacy design demonstrations in `public/preview/` are not part of the website distribution. The separate `site/` starter is not a build dependency.

The renderer honors reduced motion and pauses while offscreen. Focus the artwork and press **P** or **Space** to pause or resume. The original artwork is retained as a fallback when WebGL is unavailable. See [third-party notices](../THIRD_PARTY_NOTICES.md) for attribution.
