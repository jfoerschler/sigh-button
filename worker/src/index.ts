/**
 * Sigh API.
 *
 * Sits at /api/* on the same origin as the page, holds the Supabase service key, and
 * applies rate limits. All integrity logic lives in Postgres; this layer validates
 * shapes, throttles, and translates the phrase into a room key.
 */

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  /** Keeps a dump of the rooms table from being dictionary-attacked back into phrases. */
  ROOM_PEPPER: string;
  ADMIN_TOKEN: string;
  DEVICE_LIMIT: RateLimiter;
  IP_LIMIT: RateLimiter;
  /** Present only under `wrangler dev`; the production route never serves static files. */
  ASSETS?: Fetcher;
}

/** Every failure the client can receive. It renders all of them gently: see web/app.js. */
type ErrorCode = 'bad_request' | 'no_room' | 'rate_limited' | 'unavailable' | 'not_found';

const HEX64 = /^[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 2048;
const MAX_PHRASE_LENGTH = 200;

function fail(code: ErrorCode, status: number): Response {
  return Response.json({ error: code }, { status });
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
  const body = await readJson(request);
  if (!body) return fail('bad_request', 400);

  const phrase = body.phrase;
  const deviceHash = body.device_hash;

  if (typeof phrase !== 'string' || typeof deviceHash !== 'string') return fail('bad_request', 400);
  if (phrase.length === 0 || phrase.length > MAX_PHRASE_LENGTH) return fail('bad_request', 400);
  // Rejected here so a malformed value never reaches Postgres, even though the function
  // checks the same pattern. Two cheap checks are worth one less thing to reason about.
  if (!HEX64.test(deviceHash)) return fail('bad_request', 400);

  const perDevice = await env.DEVICE_LIMIT.limit({ key: deviceHash });
  if (!perDevice.success) return fail('rate_limited', 429);

  const address = request.headers.get('cf-connecting-ip');
  if (address) {
    const perAddress = await env.IP_LIMIT.limit({ key: address });
    if (!perAddress.success) return fail('rate_limited', 429);
  }

  const result = await callRpc(env, 'push', {
    p_room_key: await roomKey(phrase, env.ROOM_PEPPER),
    p_device_hash: deviceHash,
  });

  if (!result.ok) return fail(result.code, result.code === 'no_room' ? 404 : 500);
  return Response.json(result.data, { headers: { 'cache-control': 'no-store' } });
}

/**
 * POST rather than GET despite being a read. The phrase is a shared secret, and a query
 * string lands in browser history, referrer headers, and every proxy log on the way.
 */
async function handleHistory(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body) return fail('bad_request', 400);

  const phrase = body.phrase;
  if (typeof phrase !== 'string' || phrase.length === 0 || phrase.length > MAX_PHRASE_LENGTH) {
    return fail('bad_request', 400);
  }

  const requested = typeof body.days === 'number' ? body.days : 90;
  const days = Math.min(Math.max(Math.trunc(requested), 1), 365);

  const result = await callRpc(env, 'history', {
    p_room_key: await roomKey(phrase, env.ROOM_PEPPER),
    p_days: days,
  });

  if (!result.ok) return fail(result.code, result.code === 'no_room' ? 404 : 500);
  return Response.json(result.data, { headers: { 'cache-control': 'no-store' } });
}

/** Room creation is deliberately not self serve: see README on why typos must not open rooms. */
async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  const presented = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!env.ADMIN_TOKEN || !secureEquals(presented, env.ADMIN_TOKEN)) {
    return fail('not_found', 404);
  }

  const body = await readJson(request);
  if (!body) return fail('bad_request', 400);

  const phrase = body.phrase;
  if (typeof phrase !== 'string' || phrase.length === 0 || phrase.length > MAX_PHRASE_LENGTH) {
    return fail('bad_request', 400);
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === 'POST') {
      if (pathname === '/api/push') return handlePush(request, env);
      if (pathname === '/api/history') return handleHistory(request, env);
      if (pathname === '/api/room') return handleCreateRoom(request, env);
    }

    // No CORS headers anywhere on purpose. The page and the API share an origin, so a
    // cross-origin caller is not something to accommodate.
    if (pathname.startsWith('/api/')) return fail('not_found', 404);

    // Local development only: wrangler serves web/ so dev matches production's single
    // origin. In production the route is /api/*, so nothing else reaches this Worker.
    return env.ASSETS ? env.ASSETS.fetch(request) : fail('not_found', 404);
  },
} satisfies ExportedHandler<Env>;
