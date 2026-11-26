import type { Config } from './config.ts';

const PREFIX = '/api/';
const ALLOWED = /^(scopes|boards|graph|memories(\/[0-9A-Za-z-]+)?)$/;
const UNREACHABLE = { error: 'web-api unreachable' };

/**
 * Forward a browser GET under /api/ to the web-api function, adding the member's bearer token.
 * The path is matched raw (still percent-encoded) against an allow-list, so no other function
 * can be reached with the token. Only the status, body and content-type come back.
 */
export async function proxyApi(req: Request, cfg: Config, fetchFn: typeof fetch = fetch): Promise<Response> {
  if (req.method !== 'GET') {
    return Response.json({ error: 'method not allowed' }, { status: 405, headers: { allow: 'GET' } });
  }
  if (req.headers.get('sec-fetch-site') === 'cross-site') {
    return Response.json({ error: 'cross-site request refused' }, { status: 403 });
  }

  const { pathname, search } = new URL(req.url);
  const rest = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : null;
  if (rest === null || !ALLOWED.test(rest)) return Response.json({ error: 'not found' }, { status: 404 });

  const headers = new Headers({ authorization: `Bearer ${cfg.token}` });
  const accept = req.headers.get('accept');
  if (accept !== null) headers.set('accept', accept);

  const base = cfg.apiUrl.endsWith('/') ? cfg.apiUrl.slice(0, -1) : cfg.apiUrl;
  let upstream: Response;
  try {
    upstream = await fetchFn(`${base}/${rest}${search}`, { method: 'GET', headers, redirect: 'manual' });
  } catch {
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
