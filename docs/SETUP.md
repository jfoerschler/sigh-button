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
5. Deal with asset caching, below. No rule is needed for the HTML.

Reversing 2 and 4 produces a certificate error that presents as a DNS problem.

### HTTPS

Turn on **SSL/TLS, Edge Certificates, Always Use HTTPS**. This is not optional: over plain
HTTP the app cannot work and fails in a way that reads as a server fault. An HTTP page
sends a different origin than the configured one, so the Worker refuses the request, and
even past that `crypto.subtle` is gated behind secure contexts, so the device hash could
never be computed. `theme.js` upgrades the protocol client side as a backstop, but that
costs a round trip and should never be the thing saving you.

GitHub's own **Enforce HTTPS** toggle is likely greyed out as "not configured correctly",
because GitHub cannot validate the domain to issue a certificate while Cloudflare proxies
it. **You do not need it.** Cloudflare terminates TLS for visitors with its own
certificate; GitHub's never reaches a browser. Its toggle only governs the leg between
Cloudflare and GitHub, and that leg carries nothing sensitive: Pages serves only public
static files, while the phrase and device hash go to the Worker on a different hostname
over its own TLS.

If you later want that leg on *Full (strict)*, that is when GitHub's certificate matters,
and it needs the grey-cloud dance: set the record to DNS-only, wait for GitHub to issue,
enable Enforce HTTPS, then re-proxy.

### Caching

Check what is actually happening before changing anything:

```bash
for f in "" style.css app.js; do
  curl -sI "https://sigh.holyhell.xyz/$f" | grep -iE 'cache-control|cf-cache-status'
done
```

Cloudflare caches static extensions by default and does **not** cache HTML by default, so
`.html` comes back `cf-cache-status: DYNAMIC` while `.css` and `.js` come back `HIT`. A
cache rule for the HTML solves nothing; the skew risk is entirely in the assets.

The four hour TTL is not GitHub's either. Pages sends `max-age=600` on everything, and
Cloudflare's **Browser Cache TTL** setting defaults to 4 hours and overrides it. Two
reasonable defaults combining into a four hour window in which a visitor can hold a
mismatched set of files.

Either fix works:

- **Caching, Configuration, Browser Cache TTL, Respect Existing Headers.** Hands control
  back to GitHub's ten minutes. One dropdown, shrinks the window by 24 times.
- **A cache rule bypassing the assets**, which closes it entirely:

  ```
  If:   (http.host eq "sigh.holyhell.xyz" and (http.request.uri.path.extension in {"js" "css"}))
  Then: Bypass cache
  ```

  Five files of a few KB on an edge that is already fast: nothing measurable is lost.

Purge once after changing it (Caching, Configuration, Purge Everything) so anyone holding
stale files gets the fix now rather than in four hours.

Page scripts are ES modules, which is what keeps a skew from being fatal. Classic scripts
share one global scope, so a cached older script beside a newer one can redeclare a name,
and that is a SyntaxError which kills the whole file rather than a warning. Modules each
get their own scope, so the worst case is unstyled rather than blank.

### Security headers

Add as a Cloudflare Transform Rule on `sigh.holyhell.xyz`:

Create it under **Modify Response Header**, not Modify Request Header. The two tabs sit
side by side with near-identical forms, and a request-header rule adds headers to the
request Cloudflare sends to GitHub, where no browser will ever see them. It fails with no
error and the dashboard still reports the rule as active.

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' https://sigh-worker.holyhell.xyz; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors 'self' teams.microsoft.com *.teams.microsoft.com
Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

The page loads no external scripts, fonts, styles or images, so every directive above can
be `'self'` or `'none'` at no cost. Verified against the real page with these exact
directives: zero violations.

Two worth understanding rather than copying:

- `form-action 'none'` is safe even though the gate is a form. The submit handler calls
  `preventDefault`, so no navigation is ever attempted; the directive only blocks the
  fallback navigation that would happen if the script failed to load, which is the
  outcome you want anyway.
- `base-uri 'none'` blocks an injected `<base>` tag from silently repointing every
  relative URL on the page, including `app.js`.

`includeSubDomains` is deliberately absent from HSTS. Adding it would commit every
subdomain of holyhell.xyz to HTTPS-only, which reaches well beyond this project.

Two parts of that CSP are load bearing, and both fail quietly:

- **`connect-src` must name the Worker origin.** It falls back to `default-src 'self'`,
  and the Worker is now a different origin, so without it every press is blocked by the
  browser with nothing shown in the interface.
- **`frame-ancestors` must name Teams**, or the Teams tab renders blank with no error.

### Rate limiting

Two layers, and it is worth knowing exactly what each one does, because measured
behaviour differs from the documentation's impression.

#### The Worker binding: best effort, counted per edge machine

`period` must be **10** seconds. A free account silently declines 60: it validates,
deploys, prints the limit back in the bindings list, and enforces correctly under
`wrangler dev`, which does not model plan entitlements. Production never fires it.
Nothing errors and nothing logs.

Even with the right period, the counter is **per edge machine, not global**. Measured
against the deployed Worker:

| Traffic | Blocked |
| --- | --- |
| 200 parallel, same device hash | 6 |
| 30 sequential, same device hash | 0 |
| 200 parallel, unique hash each | 0 |

Sequential requests are spread across machines, so each local counter stays under the
limit. Treat this as a brake on one browser mashing hard, which is its actual job, and
not as a ceiling you can rely on.

#### The zone rule: the volumetric backstop

Security, WAF, Rate limiting rules. Expression:

```
(http.host eq "sigh-worker.holyhell.xyz" and starts_with(http.request.uri.path, "/api/"))
```

Counting characteristic: IP. Period and block duration are both capped at **10 seconds**
on a free account.

**Verify it fires before trusting it.** Set the rate deliberately low first, for example
20 requests per 10 seconds, then send a burst:

```bash
seq 1 60 | xargs -P 10 -I{} curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://sigh-worker.holyhell.xyz/api/push \
  -H 'content-type: text/plain' \
  -d '{"phrase":"probe","device_hash":"'"$(printf '0%.0s' {1..64})"'"}'
```

A zone block returns Cloudflare's own response. If the body reads
`{"error":"rate_limited"}` that came from the Worker binding, not the rule, and the rule
is still not matching. Once it fires, raise the rate to **100 per 10 seconds**.

Keep the production rate loose. BU routes many people through few egress addresses, so a
tight per-IP rule reads a whole building as one abusive client and refuses real presses
during exactly the busy moments the button exists for.

#### What neither layer stops

Someone with the phrase who sends a fresh device hash per request. `DEVICE_LIMIT` cannot
catch it (the key is theirs to choose) and the IP rule only catches it at volume. This is
accepted and stated plainly in `about.html`: the phrase is the real gate, and the counts
that matter are bounded by the 25 per day per device cap in Postgres, where the caller
has no say.

### Keepalive

Add a Cloudflare Cron Trigger every few days that calls `/api/history` with any real
phrase. Without it, Supabase pauses the project after a quiet week and the button comes
back broken.

## 4. Create a group

### From the website

Open `https://sigh.holyhell.xyz/admin.html` and fill in the form. It is not linked from
anywhere, but be clear about what that does and does not mean: a static host serves any
path asked for, so the page is public. The admin code is the gate, not the filename. The
Worker refuses a wrong code with the same 404 it gives an unknown path, and throttles the
attempts, so guessing is slow and tells the guesser nothing.

The code is held in memory for one submit and never written to storage or a URL.

If the database was created before this existed, run `supabase/002-room-exists.sql` so a
duplicate phrase reports as a duplicate instead of a server fault.

### From the command line


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
