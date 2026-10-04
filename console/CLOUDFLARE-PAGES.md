# Three Pages projects, one frontend repository

This is configuration/runbook documentation. The extraction PR does not create Pages projects, attach domains, change DNS, deploy an API, or remove running legacy web containers.

Paired API/source-ownership change: [respire-server PR #6](https://github.com/risense-ai/respire-server/pull/6). It is a draft dependency, not a deployed revision. At rollout, record the actual merged/deployed API revision rather than pinning its current draft head.

## Project configuration

Use `risense-ai/respire-site`, production branch `main`, Node 22, and **leave the root directory empty** (repository root) for all three projects.

| Project | Build command | Output directory | Domain after validation |
| --- | --- | --- | --- |
| Existing homepage | `cd homepage && npm ci && npm run check && npm test && npm run build` | `site/dist/client` | `rsrs.rs` |
| Dashboard | `cd console && npm ci && npm run check && npm test && npm run build:dashboard` | `console/dist/dashboard` | `dash.rsrs.rs` |
| Admin | `cd console && npm ci && npm run check && npm test && npm run build:admin` | `console/dist/admin` | `admin.rsrs.rs` |

Console production environment: `NODE_VERSION=22`, `VITE_API_BASE_URL=https://api.rsrs.rs`. No credentials, recovery material, private API token belong in Pages environment variables. Each project serves its own artifact; do not deploy the parent `console/dist` directory.

Suggested Pages build watch paths:

- Homepage: `homepage/**`, `site/**`, `scripts/**`, `.github/workflows/**`, `LICENSE`, `COMMERCIAL-LICENSE.md`, `THIRD_PARTY_NOTICES.md`
- Dashboard and Admin: `console/**`, `scripts/**`, `.github/workflows/**`, `LICENSE`, `COMMERCIAL-LICENSE.md`, `THIRD_PARTY_NOTICES.md`

The existing homepage layout, language paths and `site/dist/client` output are unchanged. Its `/dashboard` and `/admin` redirects default to the existing custom domains. For isolated DEV Pages projects, use a dedicated DEV branch and set `VITE_DASHBOARD_URL` and `VITE_ADMIN_URL` to the respective DEV HTTPS origins; both links and built path redirects follow these values. Set console `VITE_API_BASE_URL` to the isolated DEV API in both build environments. Keep these projects separate from the existing production homepage.

## API and preview map

| Environment | Dashboard/Admin UI | API |
| --- | --- | --- |
| Production (after cutover) | `https://dash.rsrs.rs`, `https://admin.rsrs.rs` | `https://api.rsrs.rs` |
| Pre-cutover smoke | Explicitly selected Pages preview deployment URLs | Explicit isolated HTTPS test API origin |
| Automated fixtures | Two different loopback UI origins created by the test | A third loopback origin created by the test |
| Legacy runtime (until cutover passes) | Existing Dashboard/Admin web container/proxy | Existing API paths |

No new preview/test domain is reserved or presumed by this PR. Before enabling console branch previews, choose an isolated test API/database/mail fixture and configure preview `VITE_API_BASE_URL` to its exact HTTPS origin. Add each exact Pages deployment/branch-alias origin to that test API's `RESPIRE_CORS_ALLOWED_ORIGINS`; never allow `*.pages.dev`, `null`, or an arbitrary reflected origin. A preview build on Cloudflare refuses the production API default, and every Cloudflare Pages build requires a remote HTTPS hostname and refuses HTTP, literal-IP and localhost API targets. Keep console previews disabled until the isolated API and origin allowlist are ready. Homepage previews retain their existing configuration.

Public previews must contain no credentials and be used with synthetic accounts only. If desired, separately configure restricted preview access before sharing; access setup is outside this PR. Never add preview origins to the production API just to make testing convenient. Dynamic deployment URLs require explicit allowlist updates or a fixed test branch alias; do not silently broaden CORS.

## Static routing and headers

Each console distribution includes `_redirects` for the legacy `/dashboard`, `/dashboard/*`, `/admin` and `/admin/*` paths, internally rewriting them to `/index.html`. The compiled target still rejects the other surface. Root loads `index.html`; Pages provides its normal SPA fallback because no `404.html` is emitted. A global `/*` rewrite is deliberately avoided so `/build-info.json` and `/licenses/` remain directly readable. These are internal SPA rewrites only; Cloudflare Pages redirects cannot proxy an external API. The compiled shared client calls the actual configured API origin. There is no same-origin API fallback.

Each distribution includes no-store, no-referrer, no-sniff and deny-framing headers. The upstream bundle uses inline JS/CSS and React inline styles. No blanket `script-src 'self'` policy is introduced: it would break this retained single-file build. A separately reviewed CSP must use actual build hashes/nonces and accommodate required inline styles and the configured API origin. Do not add `unsafe-eval`, wildcard API access, or speculative weakened CSP to get a preview working.

At the new UI origins, `/admin/*` is an Admin SPA deep link. On the API origin, `/admin/*` remains the Admin JSON API. The old combined nginx/proxy routes reserve `/admin/*` for API, so test the new Pages behavior explicitly rather than assuming old routes are identical.

## Ordered release gates

1. **Prepare rollback and deploy API first.** Record the exact API revision and health/readiness evidence. Preserve the running legacy web image/container, config, environment and route snapshots. Source moves in these PRs do not authorize deleting runtime assets. Deploy using the paired API-only procedure; do not rebuild or recreate the old web container from the now API-only Server repository.
2. **Validate API CORS without moving traffic.** Check allowed and disallowed origins, OPTIONS with Authorization/JSON headers, and 401/403/429/5xx error visibility. Validate native CLI compatibility and existing user/admin authorization. Use fixture data only for writes.
3. **Build and verify all three Pages projects.** Site owns Homepage, Dashboard and Admin build/browser/hosted acceptance. Use exact tested Site commit/artifact provenance and validate all three `build-info.json` records against the expected Site revision, and independently verify the deployed API revision. Run hosted acceptance only with the explicit operator approvals in [the hosted smoke contract](tests/HOSTED-SPLIT-SMOKE.md); normal Site CI and Pages builds never invoke it. First verify isolated API previews, `/`, matching legacy paths, hash/deep links, mobile rendering, Back/Forward, login failure, TOTP challenge, expiry, email UI and vault round trips. Verify no calls go to the Pages origin or production API during preview tests. Production builds must record `https://api.rsrs.rs`, not a fixture/test URL.
4. **Migrate traffic only after both pass.** Attach `dash.rsrs.rs` and `admin.rsrs.rs` through Pages custom domains and verify certificate/DNS/origin behavior before removing corresponding legacy routes. Preserve these exact origins so origin-local tokens/recovery storage stay available. Use a fresh synthetic session for release checks; never move tokens through URLs. Test cached existing sessions and recovery-expiry behavior on the final origins with explicit operator authorization.
5. **Clean up old runtime last.** Once final-origin checks pass and rollback is accepted, remove only obsolete frontend routes/containers/assets. Preserve API/legacy API routes and native client compatibility. This phase requires a separate deployment/change approval. Roll back a failed frontend cutover by restoring the recorded old routes and preserved image, not by reconstructing it from the API-only Server source.

CI fixture/browser tests are not evidence that Cloudflare DNS, certificates, provider settings, actual production CORS, email delivery or live authentication have been verified. Record these separately at rollout time with API revision, Site revision, target/API origin from `build-info.json`, Pages deployment URLs and artifact checksums.

Reference: [Pages build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/), [redirects](https://developers.cloudflare.com/pages/configuration/redirects/), [headers](https://developers.cloudflare.com/pages/configuration/headers/), [monorepos](https://developers.cloudflare.com/pages/configuration/monorepos/), [SPA serving behavior](https://developers.cloudflare.com/pages/configuration/serving-pages/).

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
