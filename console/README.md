# Respire Dashboard and Admin

One React console codebase produces two independent Cloudflare Pages distributions. The source is extracted from [`respire-server/admin-ui` at `84ad000ae50758756edb077c63c0a1b31eb9ada2`](https://github.com/risense-ai/respire-server/tree/84ad000ae50758756edb077c63c0a1b31eb9ada2/admin-ui). See `upstream.json` for unchanged-file checksums and the small, explicit integration change list. First-party licensing remains [Respire Noncommercial License 1.0](../LICENSE); preserve the [commercial license notice](../COMMERCIAL-LICENSE.md) and dependency licenses.

## Commands (Node 22)

```sh
cd console
npm ci
npm run check
npm test
npm run build
npx playwright install --with-deps chromium
npm run test:render
npm run test:browser
```

- `npm run build:dashboard` → `dist/dashboard/`, fixed Dashboard target
- `npm run build:admin` → `dist/admin/`, fixed Admin target
- `npm run dev:dashboard` / `npm run dev:admin` select the same explicit targets
- `npm run test:render` checks both compiled production sign-in screens at desktop/mobile sizes
- `npm run test:browser` builds isolated test bundles with a loopback fixture API and exercises cross-origin browser flows. It does not connect to production or send email.
- `RESPIRE_BROWSER_EXECUTABLE=/path/to/chromium` selects an installed browser for local QA.

The Vite mode determines the surface at `/`, independent of URL path or token contents. The matching legacy `/dashboard` or `/admin` entry and its hash routes still work. Matching nested paths normalize to hash navigation (for example `/dashboard/memories/id` → `/dashboard#/memories/id`). An Admin pathname cannot switch a Dashboard build to the Admin surface, or vice versa. English/Chinese catalogs, UI styling, vault crypto and auth forms are retained.

## API configuration

`VITE_API_BASE_URL` is a **public build-time origin**, defaulting to `https://api.rsrs.rs`. Only HTTPS origins are accepted, except loopback HTTP for local fixtures. Paths, query strings, embedded credentials and fragments are rejected. Configure it before each build; rebuilding is required to change it. Never put secrets in a `VITE_*` variable.

All cloud-console requests go directly to that API origin with existing logical paths, such as `/api/self`, `/login` and `/admin/me`. The shared client sends bearer tokens with `credentials: omit`; it neither uses cookies nor tunnels the API through Pages redirects. Unauthorized handlers still receive the original logical path and request token, preserving user/admin session invalidation rules.

Production API configuration in the paired Server PR:

```dotenv
RESPIRE_CORS_ALLOWED_ORIGINS=https://dash.rsrs.rs,https://admin.rsrs.rs
```

The API allows exact origins, GET/POST, and the `Authorization`/`Content-Type` request headers. OPTIONS preflight runs before authentication, JSON body parsing or database access. Allowed-origin errors also carry the exact origin and `Vary: Origin`; credentials/wildcards are not used. API authorization and user/admin roles remain enforced by the backend.

Browser tokens and recovery material stay in their existing origin-local storage keys. Retaining `dash.rsrs.rs` and `admin.rsrs.rs` preserves existing browser origins. Pages preview origins require separate synthetic sign-in; do not copy production tokens or recovery codes into previews, URLs, query strings, build variables or logs.

## Opt-in hosted migration acceptance

`npm run test:hosted` is a separate, explicitly gated test for an approved isolated API, Dashboard, Admin and homepage. It validates the clean exact Site checkout, all three live frontend build metadata records and independent API revision before creating fixtures. See [hosted split-origin smoke prerequisites](tests/HOSTED-SPLIT-SMOKE.md) for the exact environment/approval contract. It sends real test email and creates/cleans up owned test identities only when deliberately enabled; it is never part of ordinary CI or Pages builds. The retained legacy smoke cannot prove this new topology.

## Deployment and provenance

See [Cloudflare Pages and staged cutover](CLOUDFLARE-PAGES.md). Each build emits `build-info.json` with the Site commit, dirty-tree flag, fixed target, public API origin and imported Server commit. Native Pages builds serve the separate Dashboard and Admin outputs. Site CI owns all three frontend builds and local browser gates. Linux runs the full local browser suites; Windows checks a clean console checkout, source, unit tests, both builds and provenance with line-ending conversion enabled. Retain deployment/artifact records and checksums as rollout evidence. The [downstream CLI boundary](CLOUDFLARE-PAGES.md#downstream-cli-acceptance-boundary) retains CLI API acceptance and its mail helper without fetching either Server or Site UI.

The upstream `tests/browser-dev-smoke.mjs` is retained for source history. It assumes the old combined `https://dev.rsrs.rs` deployment and performs real fixture-account/mail operations behind its explicit approval gates. It is deliberately not a package script or CI step for this extraction. Do not run it against production or treat it as verification of the new split-origin rollout.

The legacy TLS IMAP helper is retained at `scripts/read-dev-mail.py` (same Server revision). Only a separately approved legacy-dev run may set `RESPIRE_DEV_MAIL_READER` to a JSON command array such as `["python3","scripts/read-dev-mail.py"]`. Its runtime IMAP credentials remain environment-only and must never be Pages/Vite variables. Offline CI does not invoke this helper.
