# Architecture

How Sigh is put together, and the rules that are easy to break by accident. See
`../README.md` for what it is.

## The three pieces

- `web/` is the static client at `sigh.holyhell.xyz`, served by GitHub Pages. No build
  step, no dependencies. Committed files are exactly what runs, which is the point: the
  repo is public so coworkers can verify what it stores.
- `worker/` is a Cloudflare Worker at `sigh-worker.holyhell.xyz`, a different origin. It
  holds the Supabase key and enforces rate limits, and serves no static files.
- `supabase/` holds the schema and the two RPC functions. All integrity logic lives in
  Postgres, behind RLS.

## Rules that are easy to break by accident

- **Never store anything that identifies a person.** No names, no emails, no IPs, no
  timestamps finer than the day. Press times are re-identifying on a small team.
- **The device hash rotates daily and per room.** Do not "fix" it to be stable.
- **Press feedback never waits on the network.** Bind to `pointerdown`, not to the fetch.
- **Never scold the user.** Every error path is read by someone already having a bad day.
- **Requests must stay "simple" (`text/plain`).** Switching to `application/json` adds a
  preflight round trip in front of every press.
- **Every response needs CORS headers, errors included.** An uncaught throw returns the
  runtime's own 500 with none, and the browser then rejects it before the client can read
  it, so the gentle error path never runs. That is why `fetch` is wrapped.
- **Rate limiting is best effort, not a ceiling.** The Worker binding counts per edge
  machine, so sequential abuse slips through: 30 sequential presses from one device hash
  were not blocked by a 10/10s limit, while 200 parallel ones were (6 of them). The zone
  rule is the volumetric backstop. Neither stops someone sending a fresh device hash per
  request, which is accepted and documented in about.html.
- **Rate limit periods must be 10 seconds.** A free account silently declines a period
  of 60: it validates, deploys, prints the limit back, and enforces under `wrangler dev`,
  then never fires in production.
- **The device-keyed rate limiter is not an abuse control.** Its key comes from the
  request body, so anyone inflating the count sends a fresh hash each time and never
  trips it. It stops one honest browser mashing, nothing more. Deliberate inflation is
  bounded by the zone rate limiting rule and the 25/day cap in Postgres.
- **Page scripts are ES modules.** Classic scripts share one global scope, so two files
  declaring the same name is a SyntaxError that kills the whole file. It also means a
  cached older script paired with a newer one can collide and blank the page. Modules get
  their own scope, so version skew degrades instead of breaking.
- **Development runs two origins** (page on :8788, Worker on :8787) so CORS mistakes fail
  locally instead of in production. Do not collapse them back onto one port.
