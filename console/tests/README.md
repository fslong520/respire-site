# Console browser regression tests

Run `npm ci`, install Playwright Chromium with `npx playwright install chromium`,
then run `npm run test:browser`. A system Chromium can be selected with
`RSRS_BROWSER_EXECUTABLE=/absolute/path/to/chromium`.

`browser-fixtures.mjs` builds the actual single-file bundle and serves it, together
with the API fixture, on one ephemeral loopback origin — mirroring the embedded
deployment where the service origin answers both the UI and the JSON API. Bare
`/admin` and `/dashboard` paths serve the SPA; `/admin/<noun>...` and the other
documented routes answer JSON. It builds into a temporary directory and deletes it
afterwards; it does not overwrite `dist` or change production configuration.

The suite checks:

- bare `/dashboard` and `/admin` surface selection, and the standalone fallback
  at `/`
- legacy `/dashboard/<page>` path-rest normalization, prefixed hashes, trailing
  slashes, deep links, and browser Back/Forward
- isolated user/admin credential slots, logout, password login, admin-token
  login, failed authentication, TOTP challenges, failed codes, and retries
- existing 401 and 403 behavior, including ordinary forbidden operations versus
  `admin token required`, and non-JSON API errors
- email verification, invalid codes, resend, and verified state after reload
- registration's recovery-code acknowledgement and encrypted vault creation
- encrypted memory creation, reading, editing, incremental sync, deep-link
  reload, lock/unlock, and recovery-code expiry
- same-origin API transport: every API call stays on the fixture origin, omits
  cookies, and traverses the restricted proxy

All accounts, tokens, codes, email addresses, and memory content are synthetic.
The API fixture is an in-memory HTTP server, not a production-contract simulator.
It records real browser requests and rejects unexpected endpoints or payloads.
A fail-closed HTTP proxy permits only the exact loopback fixture origin and its
explicit HTTP methods. It rejects all other destinations, CONNECT requests, and
WebSocket upgrades before making any upstream connection. Chromium is configured
to proxy loopback traffic, and the suite checks that all fixture requests
reached the proxy. This suite uses neither Playwright routing nor direct CDP
interception. Playwright's route handler can synthesize successful responses and
hide real transport failures; the separate hosted guard uses direct CDP and has
its own CORS proof below. No browser security controls are disabled.

The suite asserts that no API request leaves the fixture origin and that no
request outside the fixture allowlist was attempted. It does not invoke the
retained upstream `browser-dev-smoke.mjs`, which is a separate, live-development
workflow.

`node --test tests/fixture-proxy.test.mjs` exercises the proxy's allowlist, blocked
ports/origins/methods, CONNECT/upgrade denial, redirect handling, and HTTP/CORS
forwarding using only local Node HTTP servers. These unit tests also run first
as part of `npm run test:browser`.

The existing source unit tests remain under `npm test`. `npm run test:render`
separately checks the normal built `dist` artifacts at desktop/mobile sizes.

## Separately approved hosted acceptance

The new `npm run test:hosted` entry point is an opt-in, mutating acceptance flow
for independently configured isolated API, Dashboard, Admin, and homepage HTTPS
origins. It is not run by this fixture suite or normal CI. See
[HOSTED-SPLIT-SMOKE.md](HOSTED-SPLIT-SMOKE.md) for every approval variable,
independent Server/Site revision gate, dedicated mail fixture, and owned-fixture
cleanup contract. Missing exact homepage provenance fails the hosted gate.

`node --test tests/hosted-split-contract.test.mjs` safely checks configuration,
source-proof and network contracts with in-memory mocked responses and no hosted
activity. It does not execute the hosted entry point or the retained legacy smoke.

`node tests/browser-hosted-cors.mjs` separately checks the exact hosted raw-CDP
guard against ephemeral loopback fixtures: actual OPTIONS reach the server,
allowed origins can read 401 responses, denied origins cannot, and redirects /
unapproved destinations remain blocked. It uses no hosted configuration or
credentials. Run it in browser-capable CI; mocked contracts alone do not establish
native CORS behavior.
