# Browser API consumer contract

The authoritative API implementation and compatibility documentation live in [`risense-ai/respire-server`](https://github.com/risense-ai/respire-server). This extraction preserves request/response contracts from Server commit `84ad000ae50758756edb077c63c0a1b31eb9ada2`; it changes only the configured transport origin and fixed frontend build target. The offline fixtures cover migration-critical paths but are not a substitute for producer-side authorization/schema tests.

Cloud browser transport: public `VITE_API_BASE_URL`, GET/POST, JSON bodies, optional `Authorization: Bearer …`, `credentials: omit`, no cookies. API failures retain status/body; 401 handling receives the logical path and originating token. Admin `403` with `admin token required` invalidates the Admin credential; ordinary role denial does not broaden permissions. The initial account probe preserves upstream behavior of returning to sign-in on 401/403. Origins/CORS and deployment order are specified in [the Pages runbook](CLOUDFLARE-PAGES.md).

## Public authentication

- POST `/register`: derived user/pass hash/salt and device name; returns user token, followed by encrypted vault setup
- POST `/login`, `/login/totp`: password-derived auth or ticket/code challenge, user token only after challenge completion
- POST `/forgot`, `/reset`: existing email recovery flow
- POST `/admin/login`, `/admin/login/totp`: existing administrator auth/challenge flow

## User bearer

- GET `/api/self`, `/api/self/keys`, `/api/self/sessions`, `/api/self/vault`
- GET `/pull` with optional `since` cursor
- POST `/push`, `/forget`: encrypted memory record or memory ID
- POST `/api/self/sessions`, `/api/self/sessions/{id}/revoke`, `/api/self/rotate`
- POST `/api/self/vault`, `/api/self/password`
- POST `/api/self/email`, `/api/self/email/confirm`
- POST `/api/self/totp/begin`, `/api/self/totp/confirm`, `/api/self/totp/disable`
- POST `/api/self/purge`: existing explicit account confirmation

## Administrator bearer and existing role checks

- GET `/admin/me`, `/admin/admins`, `/admin/outbox`, `/admin/audit` (page query)
- GET `/admin/users` (`q`, `page`, `limit`, `status`, optional `export`)
- GET `/admin/users/{user}/sessions`
- POST `/admin/users`, `/admin/admins`, `/admin/admins/{user}/revoke`
- POST `/admin/users/{user}/sessions`, `/admin/users/{user}/sessions/{id}/revoke`
- POST `/admin/users/{user}/update`, `/admin/users/{user}/kick`, `/admin/users/{user}/restore`, `/admin/users/{user}/delete`, `/admin/users/{user}/purge`
- POST `/admin/password`, `/admin/totp/begin`, `/admin/totp/confirm`, `/admin/totp/disable`

Path parameters representing user names are URL-encoded by the retained consumer. No endpoint becomes authorized merely because its UI is present. Existing role filtering and producer enforcement remain unchanged. Email binding and TOTP business-policy changes are outside this PR.
