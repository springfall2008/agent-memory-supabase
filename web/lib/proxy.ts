import type { Config } from './config.ts';

const PREFIX = '/api/';
const ALLOWED = /^(scopes|boards|graph|usage|memories(\/[0-9A-Za-z-]+)?)$/;
const POST_ALLOWED = /^(hints|intents|amendments|boards\/control)$/;
const UNREACHABLE = { error: 'web-api unreachable' };
/** How long the upstream gets to answer (and to send its body) before the browser is told it is unreachable. */
export const UPSTREAM_TIMEOUT_MS = 15_000;
/** A write runs more queries upstream than a read, so it gets longer. */
export const POST_TIMEOUT_MS = 30_000;
/** The largest request body a write may carry. */
export const MAX_BODY_BYTES = 16 * 1024;

const JSON_TYPE = /^application\/json\s*(;|$)/i;

function refuse(error: string, status: number, allow?: string): Response {
  return Response.json({ error }, { status, headers: allow === undefined ? undefined : { allow } });
}

/** True when the headers prove the request came from this server's own page. */
function sameOrigin(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site !== null) return site === 'same-origin';
  const origin = req.headers.get('origin');
  return origin !== null && origin === new URL(req.url).origin;
}

/** Read the body, stopping as soon as it passes `max` bytes. Null means it was over. */
async function readCapped(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > max) {
    await req.body?.cancel();
    return null;
  }
  if (req.body === null) return new Uint8Array(new ArrayBuffer(0));
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Forward a browser request under /api/ to the web-api function, adding the member's bearer token.
 * GETs reach the read routes; POSTs reach exactly the write routes, and only when the headers prove the request came
 * from this server's own page (Sec-Fetch-Site, or failing that an Origin equal to the request's), the body is JSON and
 * it is at most 16 KiB. The path is matched raw (still percent-encoded) against an allow-list, so no other function
 * can be reached with the token. Only the status, body and content-type come back. An upstream that has not answered
 * within `timeoutMs` (15 s for a GET, 30 s for a POST by default) is aborted and reported as unreachable, so a hung
 * request cannot keep the page looking live.
 */
export async function proxyApi(
  req: Request,
  cfg: Config,
  fetchFn: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<Response> {
  const { pathname, search } = new URL(req.url);
  const rest = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : null;

  let body: Uint8Array<ArrayBuffer> | undefined;
  if (req.method === 'POST') {
    if (rest === null || !POST_ALLOWED.test(rest)) return refuse('method not allowed', 405, 'GET');
    if (!sameOrigin(req)) return refuse('cross-site request refused', 403);
    if (!JSON_TYPE.test(req.headers.get('content-type') ?? '')) {
      return refuse('content type must be application/json', 415);
    }
    const read = await readCapped(req, MAX_BODY_BYTES);
    if (read === null) return refuse('request too large', 413);
    body = read;
  } else if (req.method !== 'GET') {
    return refuse('method not allowed', 405, 'GET');
  } else {
    if (req.headers.get('sec-fetch-site') === 'cross-site') return refuse('cross-site request refused', 403);
    if (rest !== null && POST_ALLOWED.test(rest)) return refuse('method not allowed', 405, 'POST');
    if (rest === null || !ALLOWED.test(rest)) return refuse('not found', 404);
  }

  const headers = new Headers({ authorization: `Bearer ${cfg.token}` });
  const accept = req.headers.get('accept');
  if (accept !== null) headers.set('accept', accept);
  if (body !== undefined) headers.set('content-type', 'application/json');

  const base = cfg.apiUrl.endsWith('/') ? cfg.apiUrl.slice(0, -1) : cfg.apiUrl;
  let upstream: Response;
  try {
    upstream = await fetchFn(`${base}/${rest}${search}`, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs ?? (body === undefined ? UPSTREAM_TIMEOUT_MS : POST_TIMEOUT_MS)),
    });
  } catch {
    // A network failure, or the timeout's abort.
    return Response.json(UNREACHABLE, { status: 502 });
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    return Response.json(UNREACHABLE, { status: 502 });
  }

  const out = new Headers();
  const type = upstream.headers.get('content-type');
  if (type !== null) out.set('content-type', type);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
