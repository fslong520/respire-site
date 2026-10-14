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

## Memory loading

Deploy the paired Server `/api/self/memories` endpoint before this console.
The dashboard reads a bounded immutable snapshot, renders decrypted batches
as pages arrive, then follows per-account incremental revisions. Pull latest,
polling and edits share that incremental stream. Loading/interruption messages
make clear when search only covers the currently loaded portion.
Sync and interruption tips float above the page without shifting the memory
tree or list. The status row continues to show the current sync state.

IndexedDB stores only ciphertext and an atomic page cursor. API origin and
authenticated username scope the cache; epoch or vault changes invalidate it.
Incomplete snapshots retain their upper boundary and resume after reopening.
Keys and plaintext stay in memory, and locking/sign-out cancels pending work.
If browser storage is blocked or full, a visible notice reports it and the
current session continues without persistent caching. No legacy API fallback
is attempted when the paired Server endpoint has not been deployed.
Successfully unlocked accounts keep their derived keys in the current page's
memory so switching back does not require another recovery-code entry. Each
token has a separate unlock session; switching discards the plaintext view.
Explicit lock and sign-out discard the corresponding keys, and reloading or
closing the page discards this in-memory cache. It is never written to browser
storage. Super passwords and legacy Secret Keys are never saved or read for
unlocking. A refresh always requires manual unlocking. Dashboard and Admin
entry automatically removes retired `onememory.superPass` and
`onememory.superPassAt` slots from local/session storage, as requested. The
encryption page lets users explicitly export remaining historical `rsrs.*` / `onememory.*` recovery-code
copies and delete them after confirming their backup. Cleanup preserves login
tokens, preferences and ciphertext. Remaining recovery copies require backup
confirmation before deletion; the two retired slots are removed automatically.

## Authenticator binding

Dashboard and Admin security pages show a locally generated QR code alongside
the manual TOTP key. Scan it with an authenticator, then enter its six-digit
code to confirm binding. The QR uses the server-provided `otpauth` URI and does
not contact a third-party image service. Binding clears the displayed setup
material and preserves the session; unbinding requires a current code and
also keeps the account signed in.

## Optional passkey memory unlock

After saving the recovery code, new accounts are offered optional passkey setup.
Existing accounts can add multiple named bindings on Encryption & keys after
entering their current recovery material once. Sign-in remains independent of
memory decryption. Keep the same recovery code: binding leaves the existing URK,
recovery wrapper, derived data keys, and memory ciphertext unchanged.

Passkey sign-in support alone does not imply PRF-based memory decryption support.
The [Bitwarden browser extension 2026.9.1 provider implementation](https://github.com/bitwarden/clients/blob/browser-v2026.9.1/apps/browser/src/autofill/fido2/utils/webauthn-utils.ts#L38-L40)
forwards only `credProps`, returns only `credProps` at creation, and returns empty
assertion extensions. This is a limitation of that version's PRF provider path,
not a claim that ordinary Bitwarden passkey authentication fails or that future
versions cannot add PRF. The UI explains this before enrollment. Error messages
separately identify unsupported creation, missing first/second verification
results, and missing output during an existing binding's unlock. They contain
no PRF output, salts, credential IDs, or telemetry payload.

The paired Server must explicitly enable the Dashboard RP and exact origin.
In the default PRF mode, registration requires runtime PRF support, a fresh assertion to wrap the existing
URK, and another independently challenged assertion to reopen that wrapper
before activation. Unsupported providers, missing PRF outputs, cancellation and
stale sessions fail closed with recovery-code fallback. An abandoned enrollment
may leave an unused entry in the provider; removing a server binding does not
delete that provider entry.

PRF output stays in the browser. HKDF-SHA-256 derives a nonextractable AES-GCM KEK,
with authenticated account/RP/credential/generation metadata. Credential transport
uses an explicit allowlist rather than `PublicKeyCredential.toJSON()`, which could
include PRF output. URKs and PRF byte buffers are wiped on completion/failure;
JavaScript cannot guarantee erasure of all engine or provider copies. Only derived
memory keys remain in the existing token-scoped in-memory unlock session. No PRF
output, KEK, root key or recovery code is sent to the API or persisted in browser
storage. Refreshing requires another unlock.

### Optional trusted-browser mode (ordinary WebAuthn)

The Server must separately enable `RSRS_TRUSTED_BROWSER_UNLOCK=1`; the setting
and the enrollment choice are off by default. Each new enrollment initially
selects PRF mode. A user may explicitly select **Trust this browser**, read the
security explanation, and enter their existing recovery code once. No provider
or user-agent detection silently selects this option.

This mode supports ordinary user-verified WebAuthn credentials without requiring
PRF output. It generates a fresh random, nonexportable AES-GCM-256 CryptoKey and
persists it in `respire-trusted-browser-v1` IndexedDB. Independent committed
readback and a cryptographic roundtrip must succeed before binding activation.
The same recovered URK is wrapped with a separate KDF identifier and authenticated
mode/account UUID/RP/credential/device UUID/key-generation metadata. Only that
opaque wrapper goes to the Server; it is not stored locally. Two fresh
user-verified assertions test enrollment before commit. A later unlock needs a
fresh verified assertion before the Server releases the matching wrapper, plus
the matching local CryptoKey to decrypt it. A signature is never treated as
symmetric key material.

Only the device CryptoKey and public identity/revision/epoch metadata persist
locally. Neither plaintext URK, recovery code, PRF output, API token nor URK
wrapper enters this IndexedDB. The existing token-scoped unlocked session still
holds only derived memory keys. Refresh preserves browser trust but requires a
fresh passkey assertion; another browser needs recovery-code setup of its own.
Loss of site storage needs recovery-code setup again, even if the provider still
holds the passkey.

This is **browser/device trust, not hardware-bound protection**. Nonexportable
means WebCrypto refuses key export; it does not protect against hostile same-
origin script, browser compromise, malware, or all browser-profile access. Keep
the recovery code. No real Bitwarden, iCloud, Windows Hello, Google Password
Manager, hardware key, or other provider account was used by these fixtures.

Signing out (including app-handled session expiry) immediately clears the
unlocked session and deletes the verified account's local trusted keys. If the
account UUID is unknown, the initiating tab conservatively clears all locally
trusted accounts and shows a notice only when that committed cleanup removed
keys. Passive tabs clear their sessions and pending metadata without repeating
durable cleanup, which could otherwise delete a newer enrollment after a delay.
Even an empty store receives a durable logout fence, so a metadata-only database
may be opened without creating browser trust. Switching accounts and successful token
rotation preserve independent account keys; no token-to-account mapping persists.
An ordinary cross-tab token replacement does not prove same-account rotation:
it can also be an account switch. Receiving tabs therefore never copy the old
token's UUID to the new token. Until an authenticated vault/passkey response
identifies the new token, that identity remains unknown. After a token storage
event, the receiving tab makes a bounded (five-second) authenticated vault lookup
before its controls become interactive. It records only that response's account
UUID, fenced to the saved token, entry generation, and current effect lifetime.
Failure, timeout, or missing identity retains the conservative unknown-account
logout fallback. Optional lookup errors cannot trigger an unfenced global signout.
The local Forget action locks memories and deletes the account's browser keys,
while server bindings stay listed until explicitly removed. Deletion failures
remain visible and do not prevent sign-out. Destructive reset independently
fences/cleans old generations; cleanup failure cannot hide the new recovery code.

Durable account/global epochs and monotonic generation floors are checked in the
same IndexedDB transaction as insertion, preventing late cross-tab writes from
recreating forgotten trust. Exact-revision leases are checked after key crypto
and immediately before accepting the first memory batch. Authoritative list
reconciliation prunes only captured, revision-matched active records; pending
same-generation keys survive an uncertain commit. Cancellation before commit
removes this enrollment's local key. After commit dispatch, the existing unknown-
outcome flow keeps the local key until safe reconciliation or explicit forgetting;
it never retries the commit or automatically removes a potentially active binding.

Recovery-code changes that preserve the same URK send `operation:
rewrap_same_urk` plus `expected_key_generation`. Destructive new-root-key resets
use `/api/self/vault/reset`, which atomically invalidates passkey bindings and
in-flight ceremonies. Deploy the paired Server before enabling this feature.

Once an enrollment commit is dispatched, cancellation or a missing response
cannot prove that no binding was saved. The UI reports an unknown outcome and
refreshes the authenticated binding list without retrying the commit or deleting
credentials. Only a matching positive list entry confirms success; an early
empty or failed read leaves uncertainty. Public pending metadata is scoped to
the session token in page memory, survives navigation, follows a successfully saved same-account token rotation,
and is cleared on logout. Ordinary account switching never transfers it.
A key-generation change removes the old retry fence without asserting that no
binding existed historically. Users can explicitly acknowledge a possible extra
credential and start a new ceremony after another fresh list check. Cancelling
that confirmation never resumes enrollment. Reconciliation is fenced to the exact
pending record observed before the read, preventing an older component response
from clearing a newer transaction. Previously confirmed notices are removed when
a later authoritative list no longer contains the binding.

## Memory graph

The graph shows non-trivial memories and their parent links. To bound main-thread
layout and SVG rendering, large collections use stable ID-sorted pages of 300
nodes. Counts describe all loaded non-trivial memories, not only the current
page. Dashed nodes have cross-page links; hover or focus one to list and open
its off-page parents/children below the graph. These relations are not treated
as missing parents. Search still covers every loaded memory. Node size uses
unique reachable descendants, including cycle members, with a visual radius cap.
