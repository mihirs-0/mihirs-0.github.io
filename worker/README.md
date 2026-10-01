# Map of Reality admin Worker

The Worker is the authenticated write boundary for the Map of Reality ledger. It can create claims and append dated updates; it cannot edit or delete published history. Direct GitHub access remains the separate recovery path.

## Deployment

- Worker: `map-of-reality-admin`
- Custom domain: `https://map-admin.mihirss.com`
- Admin sign-in: `https://map-admin.mihirss.com/admin`
- Fixed repository: `mihirs-0/mihirs-0.github.io`
- Fixed file: `data/map-of-reality.json`
- **Production ledger branch: `main`.** The Map deployment was tested on `map-of-reality` before the approved merge. Future tests must use an isolated branch and an explicitly configured staging Worker.

The Worker serves the same admin HTML checked into `instruments/map-of-reality-admin.html`. Its API origin is `https://map-admin.mihirss.com`. The sign-in form is public; publishing and updating require authentication. The admin page is unlisted and excluded from indexing, which is not an access control.

GitHub Pages serves `main`, and the public Map page is live at `https://mihirss.com/instruments/map-of-reality.html`. The production Worker writes the same branch. Use branch previews for future changes before merge; do not publish temporary tests through the production Worker.

```sh
cd worker
npm ci
npm test
npm run check
npm run deploy
```

Wrangler and the Cloudflare runtime test tool are pinned in the lockfile. Secrets must be stored separately in Cloudflare; deployment preserves existing secrets. The custom domain requires `mihirss.com` to be an active zone in the selected Cloudflare account. The `workers.dev` hostname and version preview URLs are disabled.

## Secrets

Use Production **Secret** bindings in Cloudflare, never plain variables or source files:

- `ADMIN_USERNAME`: chosen admin login.
- `ADMIN_PASSWORD`: a unique password of at least 16 characters.
- `SESSION_SECRET`: at least 32 characters of cryptographically random material.
- `GITHUB_TOKEN`: a fine-grained personal access token owned by `mihirs-0`, selecting only `mihirs-0.github.io`, with **Contents: read and write**. Metadata read is automatic; no other repository or account permission is needed. Choose an expiration and replace it before expiry.

GitHub Contents permission applies to repository contents, not a single file or branch. The token therefore remains a higher-trust credential; the Worker narrows its use to the hard-coded repository/file. No generic GitHub proxy is exposed. Keep token values out of chat, screenshots, request logs, commits, and frontend JavaScript. Use direct secret entry in Cloudflare or the interactive `wrangler secret put NAME` command.

All four secrets, a valid branch binding, and the login rate limiter are required. Incomplete configuration fails closed. No real secret is used in the test suite.

## Security and history

- Signed, host-only `__Host-` session cookie: HttpOnly, Secure, SameSite=Strict, eight-hour expiry.
- Cryptographic signature verification and strict expiry parsing. Rotating a credential or the signing secret invalidates all sessions.
- Logout clears the browser cookie. Previously copied cookies remain valid until expiry or credential/signing-key rotation; sessions are stateless.
- Exact allowed origins: `https://mihirss.com` and `https://map-admin.mihirss.com`. Writes require an allowed Origin and JSON; CORS alone is not treated as authorization.
- Cloudflare login limiter: five attempts per IP per minute. Counters are approximate and local to a Cloudflare location; this is not a global distributed-attack lockout.
- Bounded request sizes, validated fields and confidence, no silent text truncation, safe UTF-8 encoding, sanitized upstream errors.
- GitHub writes include the previous file SHA. Conflicting publications return a conflict rather than overwrite a newer ledger. If a response is uncertain, check GitHub before retrying; publication is not automatically retried.
- Existing claims and update arrays remain intact. A malformed ledger fails closed and needs GitHub repair.
- No edit/delete routes. GET `/api/entries` returns `405` with `Allow: POST`; DELETE/PUT/PATCH rejection is exercised in the isolated runtime test suite.
- Worker logs/traces are disabled. Code does not log credentials, request bodies, or upstream response bodies.

## Validation for future changes

1. Use a separate staging Worker with `LEDGER_BRANCH=map-of-reality`; production remains on `main`.
2. Sign in privately in `/admin`; check invalid login returns 401.
3. Publish one clearly labeled temporary test claim; check the returned ID and GitHub ledger commit on `map-of-reality`.
4. Render that committed ledger with the exact branch public page at desktop and mobile widths; exercise filters and navigation.
5. Append an update; verify the original claim is unchanged and the dated update renders.
6. Confirm no delete or overwrite controls/API routes exist.
7. Remove only the temporary test claim through direct GitHub access, preserving any other entries. Confirm the ledger starts clean.
8. Review the final diff against `main`, show the result, and obtain merge approval. Do not merge automatically.

Local tests use Cloudflare's actual runtime with a simulated GitHub contents service. They cover valid/invalid login, cookies, malformed sessions, credential rotation, missing setup, origin checks, request validation/size limits, Unicode, append-only publication, history preservation, fixed branch/path, conflict responses, sanitized failures, throttling, and rejected destructive methods. Live GitHub publication and visual checks are separate evidence.
