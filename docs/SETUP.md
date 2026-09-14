# Setup

Four pieces: a Supabase project, a Cloudflare Worker, DNS, and GitHub Pages. The first
three need your accounts, so they are yours to run.

## 1. Supabase

1. Create a project (free tier is plenty).
2. Open the SQL editor and run `supabase/schema.sql` in full.
3. Confirm the lockdown took. In the SQL editor, run this as the `anon` role:

   ```sql
   set role anon;
   select * from pushes;
   ```

   It must fail with a permissions error. If it returns rows, RLS did not apply and
   nothing else in this document matters yet.

4. Copy the project URL and the **service role** key from Settings, API. The service role
   key bypasses RLS, so it belongs only in a Worker secret, never in the repo or the page.

Free projects pause after 7 days with no activity. Step 2 of the Worker section adds a
cron that prevents it.

## 2. Worker

```bash
cd worker
npm install
npx wrangler login
```

Set the secrets. `ROOM_PEPPER` and `ADMIN_TOKEN` should be long random strings; generate
them rather than inventing them:

```bash
openssl rand -hex 32
```

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put ROOM_PEPPER
npx wrangler secret put ADMIN_TOKEN
```

`ROOM_PEPPER` cannot change after rooms exist. It is an input to the room key, so
changing it makes every existing room unreachable.

Deploy:

```bash
npx wrangler deploy
```

## 3. DNS and routing

Two hostnames:

- `sigh.holyhell.xyz` serves the page, from GitHub Pages.
- `sigh-worker.holyhell.xyz` serves `/api/*`, the Worker.

They are different origins, so calls from the page are cross-origin. That is handled and
costs nothing: the client sends simple requests (`text/plain`), which the CORS spec
exempts from preflight, and the Worker returns `access-control-allow-origin` so the page
may read the reply.

### The Worker hostname

`wrangler deploy` creates it. The `routes` entry in `wrangler.jsonc` is a custom domain,
so Cloudflare adds the DNS record itself. Nothing to do by hand.

Confirm it answers, and that it refuses to serve the page:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://sigh-worker.holyhell.xyz/
```

That must be 404. The Worker serves static files only on localhost; if this returns the
page, the app is reachable at two URLs and the asset guard is not working.

### The Pages hostname

Order matters. GitHub issues the certificate by validating the hostname, and cannot do
that while Cloudflare proxies it.

1. In the repo settings, set the Pages custom domain to `sigh.holyhell.xyz`.
2. In Cloudflare DNS, add a CNAME from `sigh` to `jfoerschler.github.io`,
   **grey-clouded** (DNS only).
3. Wait for GitHub to report the certificate as issued.
4. Switch the record to **orange-clouded**, and set SSL mode to **Full**.
5. Add a cache rule bypassing cache for `/` and `*.html`, so a deploy is not masked by a
   stale edge copy.

Reversing 2 and 4 produces a certificate error that presents as a DNS problem.

### Security headers

Add as a Cloudflare Transform Rule on `sigh.holyhell.xyz`:

```
Content-Security-Policy: default-src 'self'; connect-src 'self' https://sigh-worker.holyhell.xyz; frame-ancestors 'self' teams.microsoft.com *.teams.microsoft.com
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

Two parts of that CSP are load bearing, and both fail quietly:

- **`connect-src` must name the Worker origin.** It falls back to `default-src 'self'`,
  and the Worker is now a different origin, so without it every press is blocked by the
  browser with nothing shown in the interface.
- **`frame-ancestors` must name Teams**, or the Teams tab renders blank with no error.

### Keepalive

Add a Cloudflare Cron Trigger every few days that calls `/api/history` with any real
phrase. Without it, Supabase pauses the project after a quiet week and the button comes
back broken.

## 4. Create a group

Rooms are not self serve, deliberately: a typo that silently opened an empty room would
show someone a count of zero, which in this app reads as "you are the only one".

```bash
curl -X POST https://sigh-worker.holyhell.xyz/api/room \
  -H 'authorization: Bearer <ADMIN_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{"phrase":"<the group phrase>","label":"<for your own reference>"}'
```

The phrase is normalized before hashing (trimmed, collapsed whitespace, lowercased), so
capitalization and spacing do not have to match exactly when people type it.

## Local development

Two terminals, because development deliberately mirrors production's two origins:

```bash
cd worker && npm run dev
```

```bash
cd worker && npm run dev:web
```

The page is then at `http://localhost:8788` and the API at `http://localhost:8787`. That
split is on purpose. An earlier setup let wrangler serve the page and the API together,
which made development same-origin while production is not, and hid a CORS bug that only
appeared when the headers were checked directly.

Put the secrets in `worker/.dev.vars` (gitignored) to exercise the database locally.

## What to check after deploying

- No `OPTIONS` preflight in the network panel. Its absence is what proves the simple-request trick is working.
- The security headers arrive: `curl -I https://sigh.holyhell.xyz/`.
- A press succeeds from the real page. If it silently does nothing, check `connect-src`.
- The Teams tab renders rather than showing a blank frame.
- A malformed device hash is rejected: it should return 400 before Postgres is touched.
