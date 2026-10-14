# Opt-in hosted split-origin acceptance

This is a separate, **mutating, operator-approved acceptance test** for four
isolated HTTPS deployments. It is never run by `npm test`, `test:browser`, the
fixture server, or ordinary CI. It does not deploy anything, move traffic, attach
domains, or approve using production accounts. Do not execute it against a
production API, database, mailbox, or frontend deployment.

From `console/`, after installing the locked dependencies and Playwright Chromium:

```sh
npm run test:hosted
# Equivalent explicit entry point:
node tests/browser-hosted-split-smoke.mjs
```

The safe, offline contract tests are separate:

```sh
node --test tests/hosted-split-contract.test.mjs
```

A separate local-only browser regression verifies the hosted network guard:

```sh
node tests/browser-hosted-cors.mjs
```

It starts only ephemeral `127.0.0.1` fixtures, consumes no hosted origin or
credential variables, and tests native Chromium plus the exact shared hosted
raw-CDP guard. Both Dashboard and Admin fixtures must produce server-recorded
Authorization/JSON OPTIONS requests and readable 401 responses. The denied
homepage fixture must also reach the real OPTIONS handler, reject JavaScript
access, and never send the actual request. A local blocked destination proves
that the protected path prevents redirects and unapproved origins before contact.
Run this in browser-capable CI after any guard or Playwright change; syntax/unit
checks alone cannot establish native CORS behavior. This local regression does
not run the hosted acceptance entry point.

Those unit tests use in-memory response objects with `.invalid` origins. They do not
launch a browser, use credentials, execute a mail reader, open sockets, or contact
hosted services. They are suitable for the normal unit-test command. Passing them
is not evidence that a deployment or the hosted browser flow has passed.

The old `tests/browser-dev-smoke.mjs` and `scripts/read-dev-mail.py` remain
byte-for-byte upstream imports. Do not repurpose the old same-origin script or
its legacy proxy SHA headers as split-origin acceptance evidence.

The user TOTP case exercises the separate second-factor login page, an invalid
code followed by a valid retry, and explicit CLI OAuth approval and denial.
The authorization page must not request the memory super password; CLI/TUI
collect it locally after authorization. The case also checks that both failed
and successful TOTP removal preserve the browser session, and that removal
remains effective after reload. These checks require a hosted run; offline
contract checks do not establish that these flows have passed.

## Required approvals and configuration

Every variable below is explicit. There are no production defaults and no
fallback to `RSRS_DEV_SERVER_ADDR` or legacy frontend SHA variables.

Before running, the operator must separately approve the test, confirm the
selected services contain only isolated test data, and approve the synthetic
fixture writes, dedicated recipient/mail reader, and fixture-only permanent
cleanup. Environment flags record these approvals; setting flags does not obtain
permission or make a production environment safe.

| Required approval variable | Required value | Approved scope |
| --- | --- | --- |
| `RSRS_SPLIT_SMOKE_APPROVED` | `true` | Execute this hosted acceptance run |
| `RSRS_SPLIT_ISOLATED_ENVIRONMENT_CONFIRMED` | `true` | All four deployments, API/database, and mailbox are isolated test resources |
| `RSRS_SPLIT_API_ADMIN_APPROVED` | `true` | Use the isolated bootstrap admin token, create synthetic fixtures, exercise authentication, inspect test outbox metadata, and verify role boundaries |
| `RSRS_SPLIT_MAIL_APPROVED` | `true` | Send verification/reset messages to the dedicated fixture recipient and execute the trusted mailbox reader |
| `RSRS_SPLIT_FIXTURE_CLEANUP_APPROVED` | `true` | Permanently purge only the exact user/admin identities created by this run and verify their removal |

| Required configuration | Meaning |
| --- | --- |
| `RSRS_SPLIT_API_ORIGIN` | Actual isolated API HTTPS origin |
| `RSRS_SPLIT_DASHBOARD_ORIGIN` | Isolated Dashboard Pages deployment HTTPS origin |
| `RSRS_SPLIT_ADMIN_ORIGIN` | Isolated Admin Pages deployment HTTPS origin |
| `RSRS_SPLIT_HOMEPAGE_ORIGIN` | Isolated homepage Pages deployment HTTPS origin, serving the root-base build |
| `RSRS_SPLIT_SERVER_SHA` | Exact 40-character lowercase Server commit compiled into the API |
| `RSRS_SPLIT_SITE_SHA` | Exact 40-character lowercase Site commit for the harness checkout and all three deployed frontend artifacts |
| `RSRS_SPLIT_ADMIN_TOKEN` | Approved isolated API bootstrap administrator token, supplied through secure environment injection |
| `RSRS_SPLIT_MAIL_ADDRESS` | Dedicated approved test recipient, never a personal/production inbox |
| `RSRS_SPLIT_MAIL_READER` | JSON command array for a trusted mailbox reader; no shell string or secrets in arguments |

The four origins must be distinct. Only HTTPS remote DNS origins are accepted;
credentials, paths, queries, fragments, IP/loopback hosts, trailing-dot hostnames,
and known production hosts (`rsrs.rs`, `www.rsrs.rs`, `api.rsrs.rs`, `dash.rsrs.rs`,
`dashboard.rsrs.rs`, `admin.rsrs.rs`) are refused. Hostnames labeled `prod` or
`production` are also refused. This denylist cannot determine the ownership or
data isolation of arbitrary hostnames: that is why explicit operator
confirmation is mandatory. No new test domain is reserved or assumed.

Use exact deployment origins without authentication redirects. All browser and
API-request redirects are rejected, including same-origin redirects. Do not
weaken this check for an access/login page. Configure the isolated API CORS
allowlist with the exact Dashboard and Admin origins before running. Both
console builds must have `VITE_API_BASE_URL` equal to the selected API origin.
Never add arbitrary previews or wildcards to production CORS.

Optional configuration:

| Variable | Default / constraints |
| --- | --- |
| `RSRS_SPLIT_MAIL_WAIT_SECONDS` | `120`; finite value from `30` through `600` |
| `RSRS_SPLIT_SMOKE_OUTPUT` | `browser-test-output/hosted-split`; each run creates a private `run-*` subdirectory |
| `RSRS_BROWSER_EXECUTABLE` | Optional absolute path to a compatible Chromium installation; otherwise use installed Playwright Chromium |

Unset `DEBUG`, `PWDEBUG`, `NODE_DEBUG`, and `NODE_DEBUG_NATIVE`. The harness
refuses these logging modes because they can expose authentication material.
Do not enable shell tracing, protocol traces, HAR capture, videos, or browser
console forwarding around a credential-bearing hosted run.

## Mail-reader contract

The retained TLS IMAP helper can be explicitly selected from `console/`:

```sh
export RSRS_SPLIT_MAIL_READER='["python3","scripts/read-dev-mail.py"]'
```

It retains its original configuration names: `RSRS_DEV_IMAP_HOST`,
`RSRS_DEV_IMAP_USERNAME`, and `RSRS_DEV_IMAP_PASSWORD`. Supply credentials
through the operator's approved secret mechanism, not source files, command-line
arguments, logs, or this document. This helper reads INBOX over TLS in read-only
mode and filters the expected purpose, recipient and receipt time.

For another approved reader, the harness appends one JSON argument:

```json
{"recipient":"synthetic@fixture.invalid","requestedAt":"2026-01-01T00:00:00.000Z","purpose":"verify_email"}
```

`purpose` is `verify_email` or `reset_password`. Return only JSON on stdout:
`{"code":"123456"}` when the matching six-digit code arrives, or `{"code":null}`
while waiting. The reader must match the exact request, not return an old or
unrelated inbox code. It runs without a shell and inherits the process environment;
use only a trusted reader. Nonzero exit, invalid JSON, or timeout fails the gate.
The test must receive actual fixture mail. It does not read verification codes
from the admin API or invent a success when email delivery fails.

## Fail-closed source proof before fixture writes

1. The actual harness checkout `git rev-parse HEAD` must equal
   `RSRS_SPLIT_SITE_SHA`, and `git status --porcelain --untracked-files=normal`
   must be empty. Commit the harness and use a clean checkout of that commit.
   These checks run before creating output, launching Chromium, contacting an
   API, or executing a mail reader. Default output and installed dependencies
   are ignored by Git; do not leave unrelated untracked files in the checkout.
2. API `/health` must return JSON with `ok: true` and exact `source_revision ===
   RSRS_SPLIT_SERVER_SHA`. Missing/`unknown`/short/mismatched revisions fail.
   This is the Server binary's compile-time revision, not an nginx header or
   runtime environment override. `/ready` must report `ok: true` and
   `database: "ready"`.
3. Dashboard and Admin `/build-info.json` must each return the same expected
   `site_revision`, explicit `source_tree_dirty: false`, the correct `target`
   (`dashboard`/`admin`), exact isolated `api_base_url`, and `imported_revision`
   matching the committed `console/upstream.json`. The imported legacy revision
   is provenance, not the expected Site commit.
4. Homepage `/build-info.json` must also return the same expected `site_revision`,
   explicit `source_tree_dirty: false`, `target: "homepage"`, and `base: "/"`.
   A `/preview/` build, absent metadata, or a stale homepage cannot pass.
5. All three roots must return HTML. The homepage must link build assets; each
   linked JS/CSS/SVG/PNG/WebP asset must be served by the same homepage origin
   with HTTP 200 and the matching MIME type. A Pages SPA fallback returning HTML
   under an asset filename fails. No probe follows redirects.

The subsequent real Chromium homepage load checks the rendered `main h1`,
Respire title, and origin before collecting a masked screenshot. Metadata alone
is not a browser-rendering test. These public build records are release evidence,
not cryptographically signed attestations; operators must also retain their
trusted deployment/artifact records.

## Browser coverage and network boundaries

The adaptation retains every strict user/admin step from the legacy smoke:
failed login and registration validation, recovery-code acknowledgement,
encrypted vault/memory create/read/edit round trips, every Dashboard view and
mobile navigation, actual email delivery and verified state after reload,
user TOTP confirmation/challenge/invalid-code rejection/disable, password change,
email password recovery, old-session and old-password rejection, reset-code
replay rejection, unchanged encrypted vault, owner/viewer permissions, all Admin
views, admin TOTP, unauthenticated requests, and user/admin token boundaries.
Both root routes and matching legacy `/dashboard`/`/admin` routes are checked on
the independently compiled frontend origins.

Browser API responses must come from the actual API origin. Chromium interception
rejects unconfigured origins, frontend-origin fetch/XHR/API activity, redirects,
WebSockets and unexpected new pages. Service workers are blocked. Accepted
responses are passed through unchanged and API responses are never mocked.
The raw CDP guard is intentionally separate from Playwright's `context.route` /
`page.route` APIs: Playwright 1.63 request routing may synthesize successful
OPTIONS responses. The separate local browser regression must pass before
claiming this guard preserves native preflights and denied-origin enforcement;
the hosted flow's functional success alone is not sufficient CORS evidence. Direct API probes and fixture operations
also disable redirects. Do not remove origin checks or redirect interception to
turn a failed deployment into a passing test.

The normal fixture suite covers additional route/history/retry combinations
without hosted services. Keep both suites; one does not replace the other.

## Cleanup and evidence

The run creates random synthetic identities with `web-smoke-`, `web-owner-`, and
`web-viewer-` prefixes. Ownership is recorded only after acknowledged creation.
If registration succeeds but a later vault/recovery-render step fails, the
acknowledged user is still eligible for cleanup. Teardown only targets those
exact owned names, even after a failed acceptance step. It checks purge/delete
responses, prior-token rejection where available, and absence from the API lists.
It never revokes arbitrary existing accounts or deletes the outbox/mailbox.
A cleanup failure makes the whole run fail. Interrupted processes or ambiguous
network failures may require an operator to verify fixture cleanup separately;
never infer that an unfinished run cleaned up successfully.

Each run writes `result.json` and masked screenshots to its private output
subdirectory. The result records independent Server/Site SHAs, all four selected
origins, step status, synthetic fixture names, and categorical network failures.
It excludes tokens, passwords, mail contents/codes, recipient address, recovery
keys, raw exceptions, request bodies, headers, and arbitrary failed URL paths.
Inputs, textareas, code/pre blocks, recovery/TOTP/verification/secret areas, and
alerts are masked in screenshots. Files use mode `0600` inside a mode `0700`
run directory. Screenshots can still contain test-account and outbox metadata;
review before sharing, and do not publish artifacts automatically.

A pass authorizes no deployment, traffic migration, production run, or legacy
runtime cleanup. Record a separately authorized hosted run's evidence alongside
Pages deployment URLs, artifact checksums, and the independent API revision.
This contract is owned and run from Site for all three frontends. The separate
[CLI PR #19](https://github.com/risense-ai/respire-cli/pull/19), reviewed at
[`912898e31953fc0eada2ee198de0170eaae64f04`](https://github.com/risense-ai/respire-cli/commit/912898e31953fc0eada2ee198de0170eaae64f04),
removes CLI web-smoke, frontend-revision requirements and browser gates; the
updated CLI workflow fetches neither Server nor Site UI. CLI retains its API
acceptance and CLI-owned mail helper. Do not add a CLI adapter that checks out
Site or invokes `test:hosted`; it belongs to Site's separately approved rollout
acceptance. Verify the actual merged CLI revision when recording this boundary.
Neither CLI API acceptance nor the old Server `admin-ui` same-origin smoke is
evidence that this contract passed. Preserve the API → Pages → traffic order in
[the staged cutover runbook](../CLOUDFLARE-PAGES.md#ordered-release-gates).
