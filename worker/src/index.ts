/**
 * Sigh API.
 *
 * Sits at /api/* on the same origin as the page, holds the Supabase service key, and
 * applies rate limits. All integrity logic lives in Postgres; this layer validates
 * shapes, throttles, and translates the phrase into a room key.
 */

interface Env {
  /** Origin of the page, e.g. https://sigh.holyhell.xyz. Public, so a var rather than a secret. */
  PAGE_ORIGIN: string;
  /** Extra origin accepted in development. Passed by `npm run dev`; never set in production. */
  DEV_ORIGIN?: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  /** Keeps a dump of the rooms table from being dictionary-attacked back into phrases. */
  ROOM_PEPPER: string;
  ADMIN_TOKEN: string;
  DEVICE_LIMIT: RateLimit;
  IP_LIMIT: RateLimit;
}

/** Every failure the client can receive. It renders all of them gently: see web/app.js. */
type ErrorCode = 'bad_request' | 'no_room' | 'rate_limited' | 'unavailable' | 'not_found';

const HEX64 = /^[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 2048;
const MAX_PHRASE_LENGTH = 200;

/*
 * The page and the API are on different hostnames, so every reply needs this header or
 * the browser refuses to let the page read it: the request would reach Postgres, write,
 * and then reject in the client. Requests themselves avoid preflight by being sent as
 * text/plain, which the CORS spec treats as a simple request.
 */
function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('origin');
  if (origin && isPageOrigin(origin, env)) {
    return { 'access-control-allow-origin': origin, vary: 'Origin' };
  }
  return {};
}

/*
 * The dev origin comes from configuration, not from inspecting the request. `wrangler dev`
 * reports request.url as the configured route hostname (sigh-worker.holyhell.xyz), not
 * localhost, so anything that infers the environment from the hostname silently fails:
 * development is deliberately indistinguishable from production on that axis.
 *
 * DEV_ORIGIN is passed by `npm run dev` and is never set on the deployed Worker, so the
 * allowance cannot outlive development.
 */
function isPageOrigin(origin: string, env: Env): boolean {
  return origin === env.PAGE_ORIGIN || (!!env.DEV_ORIGIN && origin === env.DEV_ORIGIN);
}

/*
 * Applied to every response, including failures. These are cheap and the API is a
 * different origin from the page, so the page's own headers do not cover it.
 */
const BASE_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

function fail(code: ErrorCode, status: number, headers: Record<string, string> = {}): Response {
  return Response.json({ error: code }, { status, headers: { ...BASE_HEADERS, ...headers } });
}

/*
 * A simple request skips preflight, which also means the browser will send it without
 * asking permission first. Checking Origin is what stops another site from driving a
 * visitor's browser into writing here. Absent Origin is allowed so curl still works.
 */
function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('origin');
  return origin === null || isPageOrigin(origin, env);
}

/**
 * Two people typing the same phrase must land in the same room, so fold away the
 * differences that are not meaningful: case, surrounding space, runs of whitespace, and
 * Unicode forms that look identical but encode differently.
 */
function normalizePhrase(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function roomKey(phrase: string, pepper: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${normalizePhrase(phrase)}:${pepper}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares without leaking the position of the first mismatch through timing. */
function secureEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return null;

  const text = await request.text();
  // content-length is caller-supplied, so the real size still has to be checked.
  if (text.length > MAX_BODY_BYTES) return null;

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function callRpc(env: Env, fn: string, args: Record<string, unknown>) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  if (response.ok) return { ok: true as const, data: await response.json() };

  // Postgres RAISE surfaces through PostgREST as a message field. The two the functions
  // raise deliberately are mapped; anything else is a fault on our side, not the user's.
  const detail = await response.text();
  if (detail.includes('no_room')) return { ok: false as const, code: 'no_room' as const };
  if (detail.includes('bad_request')) return { ok: false as const, code: 'bad_request' as const };
  console.error('rpc failed', fn, response.status, detail);
  return { ok: false as const, code: 'unavailable' as const };
}

async function handlePush(request: Request, env: Env): Promise<Response> {
  const headers = cors(request, env);
  const body = await readJson(request);
  if (!body) return fail('bad_request', 400, headers);

  const phrase = body.phrase;
  const deviceHash = body.device_hash;

  if (typeof phrase !== 'string' || typeof deviceHash !== 'string') return fail('bad_request', 400, headers);
  if (phrase.length === 0 || phrase.length > MAX_PHRASE_LENGTH) return fail('bad_request', 400, headers);
  // Rejected here so a malformed value never reaches Postgres, even though the function
  // checks the same pattern. Two cheap checks are worth one less thing to reason about.
  if (!HEX64.test(deviceHash)) return fail('bad_request', 400, headers);

  const perDevice = await env.DEVICE_LIMIT.limit({ key: deviceHash });
  if (!perDevice.success) return fail('rate_limited', 429, headers);

  // Unconditional for the same reason as the admin path: a limiter that is skipped when
  // its key is missing is a limiter that can be absent exactly when it matters.
  const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const perAddress = await env.IP_LIMIT.limit({ key: address });
  if (!perAddress.success) return fail('rate_limited', 429, headers);

  const result = await callRpc(env, 'push', {
    p_room_key: await roomKey(phrase, env.ROOM_PEPPER),
    p_device_hash: deviceHash,
  });

  if (!result.ok) return fail(result.code, result.code === 'no_room' ? 404 : 500, headers);
  return Response.json(result.data, { headers: { ...BASE_HEADERS, ...headers } });
}

/**
 * POST rather than GET despite being a read. The phrase is a shared secret, and a query
 * string lands in browser history, referrer headers, and every proxy log on the way.
 */
async function handleHistory(request: Request, env: Env): Promise<Response> {
  const headers = cors(request, env);
  const body = await readJson(request);
  if (!body) return fail('bad_request', 400, headers);

  const phrase = body.phrase;
  if (typeof phrase !== 'string' || phrase.length === 0 || phrase.length > MAX_PHRASE_LENGTH) {
    return fail('bad_request', 400, headers);
  }

  const requested = typeof body.days === 'number' ? body.days : 90;
  const days = Math.min(Math.max(Math.trunc(requested), 1), 365);

  const result = await callRpc(env, 'history', {
    p_room_key: await roomKey(phrase, env.ROOM_PEPPER),
    p_days: days,
  });

  if (!result.ok) return fail(result.code, result.code === 'no_room' ? 404 : 500, headers);
  return Response.json(result.data, { headers: { ...BASE_HEADERS, ...headers } });
}

/** Room creation is deliberately not self serve: see README on why typos must not open rooms. */
async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  const headers = cors(request, env);

  /*
   * Throttled before the token is examined. Constant-time comparison stops timing
   * attacks but nothing was stopping repeated guessing, which left the only endpoint
   * carrying a credential as the only one with no limit.
   *
   * Always throttled, never conditionally. Keying on an address that turned out to be
   * absent would skip the limiter entirely, so an unknown address shares one bucket
   * instead. Cloudflare always sets cf-connecting-ip in production and overwrites any
   * client-supplied value, so the fallback should never be reached there.
   */
  const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const attempts = await env.DEVICE_LIMIT.limit({ key: `admin:${address}` });
  if (!attempts.success) return fail('not_found', 404, headers);

  const presented = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!env.ADMIN_TOKEN || !secureEquals(presented, env.ADMIN_TOKEN)) {
    return fail('not_found', 404);
  }

  const body = await readJson(request);
  if (!body) return fail('bad_request', 400, headers);

  const phrase = body.phrase;
  if (typeof phrase !== 'string' || phrase.length === 0 || phrase.length > MAX_PHRASE_LENGTH) {
    return fail('bad_request', 400, headers);
  }

  const result = await callRpc(env, 'create_room', {
    p_room_key: await roomKey(phrase, env.ROOM_PEPPER),
    p_label: typeof body.label === 'string' ? body.label : null,
    p_timezone: typeof body.timezone === 'string' ? body.timezone : 'America/New_York',
  });

  if (!result.ok) return fail(result.code, 500);
  return Response.json(result.data);
}

export default {
  /*
   * Everything is wrapped, because an uncaught throw would be answered by the runtime's
   * own 500, which carries none of the CORS headers below. Cross-origin, the browser
   * rejects such a response before the page can read its status, so the client's gentle
   * error path never runs and the user gets silence instead of an explanation.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error('unhandled', error);
      return fail('unavailable', 500, cors(request, env));
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith('/api/')) {
      if (!originAllowed(request, env)) return fail('not_found', 404);

      // Nothing should preflight, since the page sends simple requests. Answered anyway
      // so a browser that decides to ask does not get a 404.
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            ...cors(request, env),
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': '86400',
          },
        });
      }
    }

    if (request.method === 'POST') {
      if (pathname === '/api/push') return handlePush(request, env);
      if (pathname === '/api/history') return handleHistory(request, env);
      if (pathname === '/api/room') return handleCreateRoom(request, env);
    }

    if (pathname.startsWith('/api/')) return fail('not_found', 404, cors(request, env));

    /*
     * This Worker serves no static files, in development or production. The page comes
     * from GitHub Pages at sigh.holyhell.xyz. An earlier version let wrangler serve web/
     * here, which made local development same-origin while production is cross-origin,
     * and that difference hid a CORS bug until it was curled for directly.
     */
    return fail('not_found', 404);
}
