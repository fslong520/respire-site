# One Pages project, three frontend domains

This is configuration/runbook documentation. The extraction PR does not create Pages projects, attach domains, change DNS, deploy an API, or remove running legacy web containers.

Paired API/source-ownership change: [respire-server PR #6](https://github.com/risense-ai/respire-server/pull/6). It is a draft dependency, not a deployed revision. At rollout, record the actual merged/deployed API revision rather than pinning its current draft head.

## Project configuration

### Deployment triggers

| Pages project | Production branch in Cloudflare | Trigger | API origin |
| --- | --- | --- | --- |
| `respire-dev-site` | `develop` | Push to `develop` | `https://api.dev.rsrs.rs` |
| `respire-site` | `main` | Merge the verified `develop` changes into `main` | `https://api.rsrs.rs` |

Both projects keep automatic production-branch deployments enabled. Disable
branch preview deployments on both projects: their custom domains are the
fixed, separately allowlisted DEV and production origins. The existing Site CI
runs for pushes and pull requests on both branches. Verify the `develop`
deployment and CI before merging it into `main`. Tags do not trigger deployment;
there is no separate tag workflow or intermediate production branch.

Each project's public build variables remain environment-specific. Cloudflare
uses its own Production environment for either project's configured production
branch; the DEV project must explicitly keep its DEV API and three frontend
origins. Backend/database deployment remains operator-local SSH, independent
of this frontend release workflow.

Use `risense-ai/respire-site`, Node 22, and **leave the root directory empty** (repository root). Keep the DEV and production Pages projects separate, with the branch bindings above.

Build command:

```sh
cd homepage && npm ci && npm run check && npm test && npm run build && cd ../console && npm ci && npm run check && npm test && npm run build && cd .. && node scripts/assemble-pages.mjs
```

Publish **`site/dist/pages`**. Attach the website, Dashboard and Admin domains to this same project. The default `pages.dev` hostname and website domain serve the homepage. The generated `_worker.js` selects the console by its exact configured hostname and only reads local Pages assets; it never proxies the API.

| Public build variable | Production project | DEV project |
| --- | --- | --- |
| `NODE_VERSION` | `22` | `22` |
| `VITE_API_BASE_URL` | `https://api.rsrs.rs` | `https://api.dev.rsrs.rs` |
| `VITE_DASHBOARD_URL` | `https://dash.rsrs.rs` | `https://dash.dev.rsrs.rs` |
| `VITE_ADMIN_URL` | `https://admin.rsrs.rs` | `https://admin.dev.rsrs.rs` |
| `VITE_HOMEPAGE_URL` | `https://rsrs.rs` | `https://dev.rsrs.rs` |

No credentials, recovery material, private API token belong in Pages environment variables. Individual component builds remain available for local checks; the combined project publishes the assembled directory, not the parent `console/dist` directory.

Suggested Pages build watch paths:

- `homepage/**`, `console/**`, `site/**`, `scripts/**`, `.github/workflows/**`, `LICENSE`, `COMMERCIAL-LICENSE.md`, `THIRD_PARTY_NOTICES.md`

The existing homepage layout, language paths and component `site/dist/client` output are unchanged. Its `/dashboard` and `/admin` redirects and links follow the same configured origins as the hostname router. DEV uses its own Pages project and isolated API, Dashboard and Admin HTTPS origins.

## API and preview map

| Environment | Dashboard/Admin UI | API |
| --- | --- | --- |
| Production (after cutover) | `https://dash.rsrs.rs`, `https://admin.rsrs.rs` | `https://api.rsrs.rs` |
| DEV | `https://dash.dev.rsrs.rs`, `https://admin.dev.rsrs.rs` | `https://api.dev.rsrs.rs` |
| Pre-cutover smoke | Explicitly selected Pages preview deployment URLs | Explicit isolated HTTPS test API origin |
| Automated fixtures | Two different loopback UI origins created by the test | A third loopback origin created by the test |
| Legacy runtime (until cutover passes) | Existing Dashboard/Admin web container/proxy | Existing API paths |

No new preview/test domain is reserved or presumed by this PR. Before enabling console branch previews, choose an isolated test API/database/mail fixture and configure preview `VITE_API_BASE_URL` to its exact HTTPS origin. Add each exact Pages deployment/branch-alias origin to that test API's `RESPIRE_CORS_ALLOWED_ORIGINS`; never allow `*.pages.dev`, `null`, or an arbitrary reflected origin. A preview build on Cloudflare refuses the production API default, and every Cloudflare Pages build requires a remote HTTPS hostname and refuses HTTP, literal-IP and localhost API targets. Keep combined-project previews disabled until the isolated API and origin allowlist are ready.

Public previews must contain no credentials and be used with synthetic accounts only. If desired, separately configure restricted preview access before sharing; access setup is outside this PR. Never add preview origins to the production API just to make testing convenient. Dynamic deployment URLs require explicit allowlist updates or a fixed test branch alias; do not silently broaden CORS.

## Static routing and headers

On console hostnames, root and matching legacy console paths serve the same `console/dist/index.html` through `env.ASSETS`, preserving hash navigation. The browser selects Admin or Dashboard by the exact configured hostname and rejects the other surface's legacy prefix. Font slices, `/source-notice.json` and `/licenses/` map to the single shared `__console/` asset directory. `/build-info.json` reports the shared bundle's provenance with the hostname's surface target. Explicit `/index.html` rewrites are omitted because Pages canonicalizes them into redirects. The homepage and its local assets remain at the website origin. The shared client calls the configured API origin directly, with no same-origin API fallback.

Each distribution includes no-store, no-referrer, no-sniff and deny-framing headers. The upstream bundle uses inline JS/CSS and React inline styles. No blanket `script-src 'self'` policy is introduced: it would break this retained single-file build. A separately reviewed CSP must use actual build hashes/nonces and accommodate required inline styles and the configured API origin. Do not add `unsafe-eval`, wildcard API access, or speculative weakened CSP to get a preview working.

At the new UI origins, `/admin/*` is an Admin SPA deep link. On the API origin, `/admin/*` remains the Admin JSON API. The old combined nginx/proxy routes reserve `/admin/*` for API, so test the new Pages behavior explicitly rather than assuming old routes are identical.

## Ordered release gates

1. **Prepare rollback and deploy API first.** Record the exact API revision and health/readiness evidence. Preserve the running legacy web image/container, config, environment and route snapshots. Source moves in these PRs do not authorize deleting runtime assets. Deploy using the paired API-only procedure; do not rebuild or recreate the old web container from the now API-only Server repository.
2. **Validate API CORS without moving traffic.** Check allowed and disallowed origins, OPTIONS with Authorization/JSON headers, and 401/403/429/5xx error visibility. Validate native CLI compatibility and existing user/admin authorization. Use fixture data only for writes.
3. **Build one Pages project and verify all three origins.** Site owns Homepage, Dashboard and Admin build/browser/hosted acceptance. Use exact tested Site commit/artifact provenance and validate all three `build-info.json` records against the expected Site revision, and independently verify the deployed API revision. Attach the isolated console custom domains before this gate so the actual hostname router is exercised. Run hosted acceptance only with the explicit operator approvals in [the hosted smoke contract](tests/HOSTED-SPLIT-SMOKE.md); normal Site CI and Pages builds never invoke it. Verify `/`, matching legacy paths, hash/deep links, mobile rendering, Back/Forward, login failure, TOTP challenge, expiry, email UI and vault round trips. Verify no API calls go to the Pages origin or production API during preview tests. Production builds must record `https://api.rsrs.rs`, not a fixture/test URL.
4. **Migrate traffic only after both pass.** Attach `dash.rsrs.rs` and `admin.rsrs.rs` through Pages custom domains and verify certificate/DNS/origin behavior before removing corresponding legacy routes. Preserve these exact origins so origin-local tokens/recovery storage stay available. Use a fresh synthetic session for release checks; never move tokens through URLs. Test cached existing sessions and recovery-expiry behavior on the final origins with explicit operator authorization.
5. **Clean up old runtime last.** Once final-origin checks pass and rollback is accepted, remove only obsolete frontend routes/containers/assets. Preserve API/legacy API routes and native client compatibility. This phase requires a separate deployment/change approval. Roll back a failed frontend cutover by restoring the recorded old routes and preserved image, not by reconstructing it from the API-only Server source.

CI fixture/browser tests are not evidence that Cloudflare DNS, certificates, provider settings, actual production CORS, email delivery or live authentication have been verified. Record these separately at rollout time with API revision, Site revision, target/API origin from `build-info.json`, Pages deployment URLs and artifact checksums.

Reference: [Pages build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/), [advanced mode and ASSETS](https://developers.cloudflare.com/pages/functions/advanced-mode/), [ASSETS pretty paths](https://developers.cloudflare.com/pages/functions/api-reference/), [headers](https://developers.cloudflare.com/pages/configuration/headers/), [SPA serving behavior](https://developers.cloudflare.com/pages/configuration/serving-pages/).

## Downstream CLI acceptance boundary

The separate [respire-cli PR #19](https://github.com/risense-ai/respire-cli/pull/19),
reviewed at [`912898e31953fc0eada2ee198de0170eaae64f04`](https://github.com/risense-ai/respire-cli/commit/912898e31953fc0eada2ee198de0170eaae64f04),
removes the CLI release workflow's web-smoke job, frontend-revision requirements
and browser acceptance gates. The updated CLI workflow fetches neither Server
nor Site UI source. It does not replace the old Server `admin-ui` checkout with
a Site `console/` checkout. CLI API acceptance and its CLI-owned mail helper
remain in that repository.

Site owns build and browser checks for Homepage, Dashboard and Admin, plus the
separately operator-approved hosted acceptance in
[the hosted smoke contract](tests/HOSTED-SPLIT-SMOKE.md). Run that contract from
the exact clean Site checkout with explicit isolated homepage, Dashboard, Admin
and API origins, independent Server/Site revisions, and an explicitly selected
trusted mail reader. Removing CLI's frontend gate neither runs this Site gate
nor makes hosted tests part of ordinary CI.

Before traffic migration, verify the actual merged CLI workflow has this
boundary and record its exact revision; the reviewed PR head is not proof of
merge or deployment. Keep CLI API acceptance evidence separate from Site
frontend evidence. Record the exact Site/API revisions, all three frontend
`build-info.json` records, Pages deployment URLs, artifact checksums, explicit
operator approvals, hosted results and actual preview/custom-domain/CORS checks
before cutover. A CLI pass or the old same-origin smoke cannot prove the
split-origin frontend release. Preserve the API → Pages → traffic sequence and
all separate deployment/change approvals above.
