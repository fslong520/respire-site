# Respire Admin UI

React consoles for administrators at `/admin` and users at `/dashboard`, built as a Vite single-file bundle. English is the default language, with Chinese available through the translation catalog. Memory search filters locally decrypted text; the browser does not decode or rank semantic vectors.

One Cloudflare Pages project serves the homepage and this shared bundle on three domains. The configured Admin and Dashboard hostnames select their surface at runtime, including at `/`; local fixtures may use `/admin` and `/dashboard`. JSON calls such as `/admin/me` and `/api/self` go directly to the independent `VITE_API_BASE_URL`. Hash routes preserve browser navigation. The API origin owns its JSON routes; Pages never proxies them.

| Command | Purpose |
|---|---|
| `npm ci` | Install the locked dependencies |
| `npm test` | Run existing routing and translation checks |
| `npm run build` | Produce `dist/index.html` and copy the embedded console artifact |
| `npm run check` | Verify sources against the upstream manifest |
| `npm run test:render` | Render the built sign-in surfaces at desktop/mobile sizes |
| `npm run test:browser` | Exercise both surfaces of the same bundle against a separate loopback API with native CORS |
