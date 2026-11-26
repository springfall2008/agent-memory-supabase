import 'jsr:@supabase/functions-js@2/edge-runtime.d.ts';
import { type Caller, connect, resolveCaller } from '../_shared/db.ts';
import { GteSmallEmbedder, LazyEmbedder } from '../_shared/embedder.ts';
import { PgMemoryStore } from '../_shared/pg-store.ts';
import { routeWebApi } from '../_shared/web-api.ts';

// Module level: reused across requests on a warm worker.
const dbUrl = Deno.env.get('SUPABASE_DB_URL');
if (!dbUrl) throw new Error('SUPABASE_DB_URL is not set');
const sql = connect(dbUrl);
// Only ranked search embeds; browse, graph and boards must never build the inference session.
const embedder = new LazyEmbedder(() => new GteSmallEmbedder());

const unauthorized = () => Response.json({ error: 'invalid or missing token' }, { status: 401 });

/** Identity comes only from the bearer token: nothing else in the request can name a member. */
async function authenticate(req: Request): Promise<Caller | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  return m ? await resolveCaller(sql, m[1]) : null;
}

async function handle(req: Request): Promise<Response> {
  let caller: Caller | null;
  try {
    caller = await authenticate(req);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('auth lookup failed', err.code, err.message);
    return Response.json({ error: 'service unavailable' }, { status: 503 });
  }
  if (!caller) return unauthorized();
  return await routeWebApi(req, new PgMemoryStore(sql, caller.memberId, embedder));
}

Deno.serve(handle);
