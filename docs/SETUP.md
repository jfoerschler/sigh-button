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

Order matters here. GitHub issues the TLS certificate by validating the hostname, and it
cannot do that while Cloudflare proxies it.

1. In the repo settings, set the Pages custom domain to `button.<your-domain>`.
2. In Cloudflare DNS, add a CNAME from `button` to `<user>.github.io`, **grey-clouded**
   (DNS only).
3. Wait for GitHub to report the certificate as issued.
4. Switch the record to **orange-clouded**, and set SSL mode to **Full**.
5. Add the Worker route `button.<your-domain>/api/*`, and add the same to
   `wrangler.jsonc` under `routes` so future deploys keep it.
6. Add a cache rule bypassing cache for `/` and `*.html`, so a Pages deploy is not masked
   by a stale edge copy.

Reversing steps 2 and 4 produces a certificate error that presents as a DNS problem.

### Security headers

GitHub Pages cannot set response headers, so add them as a Cloudflare Transform Rule on
`button.<your-domain>`:

```
Content-Security-Policy: default-src 'self'; frame-ancestors 'self' teams.microsoft.com *.teams.microsoft.com
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

`frame-ancestors` must name Teams explicitly, or the Teams tab renders blank with no
error message.

### Keepalive

Add a Cloudflare Cron Trigger every few days that calls `/api/history` with any real
phrase. Without it, Supabase pauses the project after a quiet week and the button comes
back broken.

## 4. Create a group

Rooms are not self serve, deliberately: a typo that silently opened an empty room would
show someone a count of zero, which in this app reads as "you are the only one".

```bash
curl -X POST https://button.<your-domain>/api/room \
  -H 'authorization: Bearer <ADMIN_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{"phrase":"<the group phrase>","label":"<for your own reference>"}'
```

The phrase is normalized before hashing (trimmed, collapsed whitespace, lowercased), so
capitalization and spacing do not have to match exactly when people type it.

## Local development

```bash
cd worker
npx wrangler dev
```

This serves `web/` and `/api/*` on one origin at `http://localhost:8787`, which matches
how production is arranged. Put the secrets in `worker/.dev.vars` (gitignored) to exercise
the database locally.

## What to check after deploying

- `/api/*` reaches the Worker, every other path reaches Pages.
- No `OPTIONS` preflight in the network panel. Its absence is what proves same-origin.
- The security headers arrive: `curl -I https://button.<your-domain>/`.
- The Teams tab renders rather than showing a blank frame.
- A malformed device hash is rejected: it should return 400 before Postgres is touched.
