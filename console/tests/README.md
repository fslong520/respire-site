# Console browser regression tests

Run `npm ci`, install Playwright Chromium with `npx playwright install chromium`,
then run `npm run test:browser`. A system Chromium can be selected with
`RESPIRE_BROWSER_EXECUTABLE=/absolute/path/to/chromium`.

`browser-fixtures.mjs` builds the actual dashboard and admin modes with
`VITE_API_BASE_URL` pointing at an ephemeral loopback HTTP fixture. It builds into
a temporary directory and deletes it afterwards; it does not overwrite `dist` or
change production configuration. Each mode has its own loopback UI origin and
both use a third, separate API origin.

The suite checks:

- root build-mode selection and rejection of the other console's pathname
- legacy `/dashboard` and `/admin` paths, prefixed hashes, trailing slashes,
  deep links, and browser Back/Forward
- isolated user/admin credentials, logout, password login, admin-token login,
  failed authentication, TOTP challenges, failed codes, and retries
- existing 401 and 403 behavior, including ordinary forbidden operations versus
  `admin token required`, and non-JSON API errors
- email verification, invalid codes, resend, and verified state after reload
- registration's recovery-code acknowledgement and encrypted vault creation
- encrypted memory creation, reading, editing, incremental sync, deep-link
  reload, lock/unlock, and recovery-code expiry
- actual HTTP OPTIONS preflights for authenticated and JSON API requests from
  both built origins

All accounts, tokens, codes, email addresses, and memory content are synthetic.
The API fixture is an in-memory HTTP server, not a production-contract simulator.
It records real browser requests and rejects unexpected endpoints or payloads.
Playwright intercepts requests only to block non-fixture origins; it never mocks
API responses. The suite asserts that no API requests target the UI origin and
that no live-service request was attempted. It does not invoke the retained
upstream `browser-dev-smoke.mjs`, which is a separate, live-development workflow.

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
