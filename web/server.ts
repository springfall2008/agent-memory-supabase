import { type Config, loadConfig } from './lib/config.ts';
import { hostAllowed } from './lib/guard.ts';
import { serveLog } from './lib/logs.ts';
import { proxyApi } from './lib/proxy.ts';
import { serveStatic } from './lib/static.ts';

export type Deps = { cfg: Config; staticRoot: string; fetchFn?: typeof fetch };

function secured(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function route(req: Request, deps: Deps): Promise<Response> {
  if (!hostAllowed(req.headers.get('host'))) return Response.json({ error: 'host not allowed' }, { status: 403 });
  const url = new URL(req.url);
  const { pathname } = url;
  if (pathname === '/api' || pathname.startsWith('/api/')) return await proxyApi(req, deps.cfg, deps.fetchFn);
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
  if (pathname.startsWith('/logs/')) return await serveLog(url, deps.cfg.runnerHome);
  return await serveStatic(deps.staticRoot, pathname);
}

/** The whole local server: host check first, then the API proxy, the log reader or the static files. */
export async function handle(req: Request, deps: Deps): Promise<Response> {
  return secured(await route(req, deps));
}

if (import.meta.main) {
  let cfg: Config;
  try {
    cfg = loadConfig((k) => Deno.env.get(k), Deno.env.get('HOME') ?? '');
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'invalid configuration');
    Deno.exit(1);
  }
  const staticRoot = decodeURIComponent(new URL('./public', import.meta.url).pathname);
  Deno.serve(
    {
      hostname: '127.0.0.1',
      port: cfg.port,
      onListen: ({ port }) => console.log(`Web UI on http://localhost:${port}`),
    },
    (req) => handle(req, { cfg, staticRoot }),
  );
}
