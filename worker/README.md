# Map of Reality admin worker

This Worker is the write boundary for the public Map of Reality instrument.

It deliberately exposes no delete endpoint. The browser never receives the GitHub token.

## Secrets

Set these as Cloudflare Worker secrets, never in source control:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `SESSION_SECRET` — a long random string
- `GITHUB_TOKEN` — a fine-grained GitHub token scoped only to `mihirs-0/mihirs-0.github.io` with Contents read/write permission

## Deploy

From this directory:

```sh
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```

The first deploy can use the generated `workers.dev` URL. For production, attach `map-admin.mihirss.com` as a Worker custom domain and then set the admin page's `API_BASE` to that origin.

## Security model

- Public GitHub Pages remains read-only.
- The GitHub token exists only inside Cloudflare's encrypted Worker secrets.
- Login creates a signed, HttpOnly, Secure, SameSite=Strict session cookie.
- The Worker can add claims and append updates.
- There is no delete route and no general-purpose GitHub proxy.
- Direct GitHub access remains the separate higher-trust recovery path.
