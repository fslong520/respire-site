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

The paired Server must explicitly enable the Dashboard RP and exact origin.
Registration requires runtime PRF support, a fresh assertion to wrap the existing
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

Recovery-code changes that preserve the same URK send `operation:
rewrap_same_urk` plus `expected_key_generation`. Destructive new-root-key resets
use `/api/self/vault/reset`, which atomically invalidates passkey bindings and
in-flight ceremonies. Deploy the paired Server before enabling this feature.

Once an enrollment commit is dispatched, cancellation or a missing response
cannot prove that no binding was saved. The UI reports an unknown outcome and
refreshes the authenticated binding list without retrying the commit or deleting
credentials. Only a matching positive list entry confirms success; an early
empty or failed read leaves uncertainty. Public pending metadata is scoped to
the session token in page memory, survives navigation, and is cleared on logout.
A key-generation change removes the old retry fence without asserting that no
binding existed historically. Users can explicitly acknowledge a possible extra
credential and start a new ceremony after another fresh list check. Cancelling
that confirmation never resumes enrollment. Reconciliation is fenced to the exact
pending record observed before the read, preventing an older component response
from clearing a newer transaction. Previously confirmed notices are removed when
a later authoritative list no longer contains the binding.
