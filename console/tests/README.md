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

## Passkey PRF coverage

The normal unit suite includes `passkeys.test.mjs`: exact same-URK and mixed
legacy/current ciphertext compatibility (recovery wrappers v1–v4), AEAD metadata
and ciphertext tampering, secret-free credential serialization, two independent
assertion PRF outputs before activation, missing/unstable PRF, cancellation,
retries, and stale account/unlock fencing. Tests separately assert creation,
first/second assertion, and unlock failure messages. An empty-extension creation
response modeled after Bitwarden browser extension 2026.9.1 proves that no
assertion prompt or registration finish/commit request follows. Assertion mocks
omit the registration-only `enabled` field. These are synthetic WebCrypto tests,
not an execution of the Bitwarden extension or hardware-provider validation.

The existing compiled-UI fixture suite also includes passkey management, multiple
bindings, memory unlock after reload, removal, recovery preservation, missing PRF,
late responses, navigation/dismissal and interrupted first memory loads. Its
`navigator.credentials` is deliberately synthetic; it does not establish real
provider support or Server signature verification.

`npm run test:browser` then runs `browser-passkey-prf.mjs` with a Chromium CDP
virtual authenticator supporting PRF. That test uses native WebAuthn creation and
assertion, the production crypto flow, and an isolated loopback service. It also
checks a PRF-disabled authenticator. Signature verification is covered separately
by the paired Server's authenticator tests. A virtual authenticator passing is
not evidence for iCloud Keychain, Google Password Manager, Windows Hello,
1Password, Bitwarden, hardware keys, or any other real provider. Test those
manually on the intended RP/origin before advertising compatibility.

Commit-lifecycle regressions additionally cover a successful synthetic write
with a failed confirmation response, cancellation before/after the write,
automatic safe list reconciliation, an early empty list remaining unknown,
explicit acknowledged retry, cancellation of a delayed retry refresh,
authoritative key-generation changes, stale cross-instance responses, removal
of a previously confirmed binding, and Memories-to-Diary route cancellation.
The failed-confirmation fixture returns a synthetic 503 after storing the binding;
it does not claim to reproduce every real network failure mode.

## Trusted-browser coverage

`trusted-browser.test.mjs` exercises the distinct authenticated AES wrapper,
same-URK/ciphertext compatibility, ordinary empty extension responses, two fresh
UV assertions, local-store failure/readback, missing keys, cancellation/staleness,
unknown commit retention, exact context checks, durable identity across token
rotation, verified-account versus unknown-identity logout cleanup, and passive
tabs that cannot repeat durable cleanup or delete a newer enrollment. Optional
authoritative identity lookup tests cover exact response ownership, token/entry
generation changes, cancellation, deadline expiry, and late ignored-abort results.

`trusted-key-store.test.mjs` uses real WebCrypto with a deliberately synthetic
IndexedDB transaction fixture. It covers nonexportable key shape, persistent
readback proof, write failures, blocked/versionchanged storage, durable cross-tab
epoch and generation fencing, revision-safe reconciliation, final-delivery
leases, cleanup failures, and atomic cleanup counts with zero-record logout
fencing. It is not a native IndexedDB conformance test.

The compiled React suite uses native IndexedDB with synthetic WebAuthn. It adds
explicit default-off opt-in, non-PRF enrollment/reload unlock, storage denial/loss,
cancelled and uncertain commits, account switching, logout/rotation, visible
cleanup failures, two-tab account-isolated logout, quiet default-off logout with
an empty key store, a cross-tab account switch that cannot inherit the old UUID,
remote rotation preserving other accounts, failed/stale identity lookup and
same-token re-entry, native transaction-drained delayed logout, reset recovery
delivery, and a key cleared during a delayed
first memory pull. The native CDP fixture additionally tests a PRF-disabled
virtual authenticator in trusted-browser mode with a genuine browser reload and
CryptoKey readback. These fixtures do not claim an actual Bitwarden extension
or real provider/hardware test; signed verification remains in the Server suite.
