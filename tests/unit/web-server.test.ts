import { assert, assertEquals, assertThrows } from '@std/assert';
import { type Config, loadConfig } from '../../web/lib/config.ts';
import { hostAllowed } from '../../web/lib/guard.ts';
import { proxyApi, UPSTREAM_TIMEOUT_MS } from '../../web/lib/proxy.ts';
import { serveStatic } from '../../web/lib/static.ts';
import { handle } from '../../web/server.ts';

const SECRET = 'tok-secret-value-123';

function envOf(vars: Record<string, string>): (k: string) => string | undefined {
  return (k) => vars[k];
}

Deno.test('loadConfig derives the web-api url', () => {
  const cfg = loadConfig(
    envOf({ AGENT_MEMORY_URL: 'https://abc.supabase.co/functions/v1/agent-memory', AGENT_MEMORY_TOKEN: SECRET }),
    '/home/u',
  );
  assertEquals(cfg.apiUrl, 'https://abc.supabase.co/functions/v1/web-api');
  assertEquals(cfg.token, SECRET);
  assertEquals(cfg.port, 8787);
  assertEquals(cfg.runnerHome, '/home/u/.board-runner');
});

Deno.test('loadConfig prefers WEB_API_URL and reads WEB_PORT', () => {
  const cfg = loadConfig(
    envOf({
      WEB_API_URL: 'http://127.0.0.1:54321/functions/v1/web-api',
      AGENT_MEMORY_URL: 'https://abc.supabase.co/functions/v1/agent-memory',
      AGENT_MEMORY_TOKEN: SECRET,
      WEB_PORT: '9000',
    }),
    '/home/u',
  );
  assertEquals(cfg.apiUrl, 'http://127.0.0.1:54321/functions/v1/web-api');
  assertEquals(cfg.port, 9000);
});

Deno.test('loadConfig tolerates a trailing slash on AGENT_MEMORY_URL', () => {
  const cfg = loadConfig(
    envOf({ AGENT_MEMORY_URL: 'https://abc.supabase.co/functions/v1/agent-memory/', AGENT_MEMORY_TOKEN: SECRET }),
    '/home/u',
  );
  assertEquals(cfg.apiUrl, 'https://abc.supabase.co/functions/v1/web-api');
});

Deno.test('loadConfig expands ~ in BOARD_RUNNER_HOME', () => {
  const base = { WEB_API_URL: 'http://x/web-api', AGENT_MEMORY_TOKEN: SECRET };
  assertEquals(loadConfig(envOf({ ...base, BOARD_RUNNER_HOME: '~/runs' }), '/home/u').runnerHome, '/home/u/runs');
  assertEquals(loadConfig(envOf({ ...base, BOARD_RUNNER_HOME: '~' }), '/home/u').runnerHome, '/home/u');
  assertEquals(loadConfig(envOf({ ...base, BOARD_RUNNER_HOME: '/abs/runs' }), '/home/u').runnerHome, '/abs/runs');
});

Deno.test('loadConfig names the missing key without its value', () => {
  const noToken = assertThrows(
    () => loadConfig(envOf({ WEB_API_URL: 'http://x/web-api' }), '/h'),
    Error,
    'AGENT_MEMORY_TOKEN',
  );
  assert(!noToken.message.includes('http://x'));

  const noUrl = assertThrows(() => loadConfig(envOf({ AGENT_MEMORY_TOKEN: SECRET }), '/h'), Error);
  assert(noUrl.message.includes('WEB_API_URL') && noUrl.message.includes('AGENT_MEMORY_URL'));
  assert(!noUrl.message.includes(SECRET));

  const badUrl = assertThrows(
    () => loadConfig(envOf({ AGENT_MEMORY_URL: 'https://abc.supabase.co/other', AGENT_MEMORY_TOKEN: SECRET }), '/h'),
    Error,
    'AGENT_MEMORY_URL',
  );
  assert(!badUrl.message.includes('abc.supabase.co'));
});

Deno.test('loadConfig rejects a bad WEB_PORT', () => {
  for (const port of ['abc', '0', '70000', '80.5', '-1', '']) {
    const err = assertThrows(
      () => loadConfig(envOf({ WEB_API_URL: 'http://x/web-api', AGENT_MEMORY_TOKEN: SECRET, WEB_PORT: port }), '/h'),
      Error,
      'WEB_PORT',
    );
    assert(!err.message.includes(SECRET));
  }
});

Deno.test('hostAllowed accepts localhost:8787 and 127.0.0.1, rejects evil.example, localhost.evil.example and null', () => {
  assert(hostAllowed('localhost:8787'));
  assert(hostAllowed('localhost'));
  assert(hostAllowed('127.0.0.1'));
  assert(hostAllowed('127.0.0.1:8787'));
  assert(!hostAllowed('evil.example'));
  assert(!hostAllowed('evil.example:8787'));
  assert(!hostAllowed('localhost.evil.example'));
  assert(!hostAllowed('localhost.evil.example:8787'));
  assert(!hostAllowed('localhost:abc'));
  assert(!hostAllowed('127.0.0.1.evil.example'));
  assert(!hostAllowed(''));
  assert(!hostAllowed(null));
});

async function withRoot(fn: (root: string, outside: string) => Promise<void>): Promise<void> {
  const parent = await Deno.makeTempDir();
  try {
    const root = `${parent}/public`;
    await Deno.mkdir(root);
    await Deno.writeTextFile(`${root}/index.html`, '<h1>hi</h1>');
    await Deno.writeTextFile(`${root}/app.js`, 'export {}');
    await Deno.writeTextFile(`${root}/style.css`, 'a{}');
    await Deno.writeTextFile(`${root}/data.json`, '{}');
    await Deno.writeTextFile(`${root}/logo.svg`, '<svg/>');
    await Deno.writeTextFile(`${root}/blob.bin`, 'x');
    await Deno.mkdir(`${root}/sub`);
    await Deno.writeTextFile(`${parent}/secret.txt`, 'TOP-SECRET');
    await fn(root, parent);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
}

Deno.test('serveStatic serves index.html for /', async () => {
  await withRoot(async (root) => {
    const res = await serveStatic(root, '/');
    assertEquals(res.status, 200);
    assertEquals(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assertEquals(await res.text(), '<h1>hi</h1>');
  });
});

Deno.test('serveStatic sets content types', async () => {
  await withRoot(async (root) => {
    const types: Record<string, string> = {
      '/app.js': 'text/javascript; charset=utf-8',
      '/style.css': 'text/css; charset=utf-8',
      '/data.json': 'application/json; charset=utf-8',
      '/logo.svg': 'image/svg+xml',
      '/blob.bin': 'application/octet-stream',
    };
    for (const [path, type] of Object.entries(types)) {
      const res = await serveStatic(root, path);
      assertEquals(res.status, 200, path);
      assertEquals(res.headers.get('content-type'), type, path);
      await res.body?.cancel();
    }
  });
});

Deno.test('serveStatic refuses ../ and %2e%2e', async () => {
  await withRoot(async (root) => {
    for (
      const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/%2E%2E/secret.txt', '/sub/../../secret.txt', '/%00']
    ) {
      const res = await serveStatic(root, path);
      assertEquals(res.status, 404, path);
      const body = await res.text();
      assert(!body.includes('TOP-SECRET'), path);
      assert(!body.includes(root), path);
    }
  });
});

Deno.test('serveStatic refuses a symlink that leaves root', async () => {
  await withRoot(async (root, outside) => {
    await Deno.symlink(`${outside}/secret.txt`, `${root}/link.txt`);
    const res = await serveStatic(root, '/link.txt');
    assertEquals(res.status, 404);
    const body = await res.text();
    assert(!body.includes('TOP-SECRET'));
    assert(!body.includes(outside));
  });
});

Deno.test('serveStatic returns 404 for directories and missing files without leaking the path', async () => {
  await withRoot(async (root) => {
    for (const path of ['/sub', '/sub/', '/nope.html']) {
      const res = await serveStatic(root, path);
      assertEquals(res.status, 404, path);
      assert(!(await res.text()).includes(root), path);
    }
  });
});

Deno.test('serveStatic rejects a missing root rather than throwing', async () => {
  const res = await serveStatic('/nonexistent-root-dir-xyz', '/');
  assertEquals(res.status, 404);
});

const CFG: Config = {
  apiUrl: 'https://abc.supabase.co/functions/v1/web-api',
  token: SECRET,
  runnerHome: '/home/u/.board-runner',
  port: 8787,
};

type Call = { url: string; init?: RequestInit };

function fakeFetch(respond: () => Response | Promise<Response>): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve().then(respond);
  }) as typeof fetch;
  return { fn, calls };
}

const jsonOk = () => Response.json({ ok: true });

Deno.test('proxyApi adds the bearer, drops browser auth and cookies, and keeps the query string', async () => {
  const { fn, calls } = fakeFetch(jsonOk);
  const req = new Request('http://localhost:8787/api/memories?tags=board%3Ax&limit=5', {
    headers: {
      authorization: 'Bearer browser-token',
      cookie: 'a=b',
      accept: 'application/json',
      'x-other': 'nope',
    },
  });
  const res = await proxyApi(req, CFG, fn);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, 'https://abc.supabase.co/functions/v1/web-api/memories?tags=board%3Ax&limit=5');
  const headers = new Headers(calls[0].init?.headers);
  assertEquals(headers.get('authorization'), `Bearer ${SECRET}`);
  assertEquals(headers.get('accept'), 'application/json');
  assertEquals(headers.get('cookie'), null);
  assertEquals(headers.get('x-other'), null);
  assertEquals(calls[0].init?.method, 'GET');
  assertEquals(calls[0].init?.redirect, 'manual');
});

Deno.test('proxyApi allows each upstream route and tolerates a trailing slash on apiUrl', async () => {
  const { fn, calls } = fakeFetch(jsonOk);
  const cfg = { ...CFG, apiUrl: `${CFG.apiUrl}/` };
  for (const path of ['scopes', 'boards', 'graph', 'memories', 'memories/3f2a-0b9c']) {
    const res = await proxyApi(new Request(`http://localhost:8787/api/${path}`), cfg, fn);
    assertEquals(res.status, 200, path);
    await res.body?.cancel();
  }
  assertEquals(calls.map((c) => c.url), [
    `${CFG.apiUrl}/scopes`,
    `${CFG.apiUrl}/boards`,
    `${CFG.apiUrl}/graph`,
    `${CFG.apiUrl}/memories`,
    `${CFG.apiUrl}/memories/3f2a-0b9c`,
  ]);
});

Deno.test('proxyApi 404s every path outside the allow-list without calling upstream', async () => {
  const { fn, calls } = fakeFetch(jsonOk);
  const paths = [
    '/api/..%2Fagent-memory',
    '/api/%2e%2e/agent-memory',
    '/api/memories/../x',
    '/api/memories/%2e%2e',
    '/api/memories/a%2Fb',
    '/api/memories/a/b',
    '/api/memories/',
    '/api/other',
    '/api/',
    '/api',
    '/api/scopes/extra',
    '/api/agent-memory',
  ];
  for (const path of paths) {
    const res = await proxyApi(new Request(`http://localhost:8787${path}`), CFG, fn);
    assertEquals(res.status, 404, path);
    assertEquals(await res.json(), { error: 'not found' }, path);
  }
  assertEquals(calls.length, 0);
});

Deno.test('proxyApi refuses non-GET methods with 405', async () => {
  const { fn, calls } = fakeFetch(jsonOk);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await proxyApi(new Request('http://localhost:8787/api/memories', { method, body: '{}' }), CFG, fn);
    assertEquals(res.status, 405, method);
    await res.body?.cancel();
  }
  assertEquals(calls.length, 0);
});

Deno.test('proxyApi refuses cross-site requests but allows same-origin, same-site, none and absent', async () => {
  const { fn, calls } = fakeFetch(jsonOk);
  const cross = await proxyApi(
    new Request('http://localhost:8787/api/scopes', { headers: { 'sec-fetch-site': 'cross-site' } }),
    CFG,
    fn,
  );
  assertEquals(cross.status, 403);
  assertEquals(await cross.json(), { error: 'cross-site request refused' });
  assertEquals(calls.length, 0);

  for (const site of ['same-origin', 'same-site', 'none']) {
    const res = await proxyApi(
      new Request('http://localhost:8787/api/scopes', { headers: { 'sec-fetch-site': site } }),
      CFG,
      fn,
    );
    assertEquals(res.status, 200, site);
    await res.body?.cancel();
  }
  const bare = await proxyApi(new Request('http://localhost:8787/api/scopes'), CFG, fn);
  assertEquals(bare.status, 200);
  await bare.body?.cancel();
  assertEquals(calls.length, 4);
});

Deno.test('proxyApi passes an upstream error status and body through', async () => {
  const { fn } = fakeFetch(() => Response.json({ error: 'invalid or missing token' }, { status: 401 }));
  const res = await proxyApi(new Request('http://localhost:8787/api/scopes'), CFG, fn);
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { error: 'invalid or missing token' });
});

Deno.test('proxyApi turns a thrown fetch into 502 without leaking the token or url', async () => {
  const { fn } = fakeFetch(() => {
    throw new Error(`connect failed ${CFG.apiUrl} ${SECRET}`);
  });
  const res = await proxyApi(new Request('http://localhost:8787/api/scopes'), CFG, fn);
  assertEquals(res.status, 502);
  const text = await res.text();
  assertEquals(JSON.parse(text), { error: 'web-api unreachable' });
  assert(!text.includes(SECRET) && !text.includes('supabase.co'));
});

Deno.test('proxyApi gives up on an upstream that never answers and returns 502', async () => {
  let signal: AbortSignal | null | undefined;
  const fn = ((_input: string | URL | Request, init?: RequestInit) => {
    signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  }) as typeof fetch;
  const res = await proxyApi(new Request('http://localhost:8787/api/graph'), CFG, fn, 20);
  assertEquals(res.status, 502);
  assertEquals(await res.json(), { error: 'web-api unreachable' });
  assert(signal?.aborted);
});

Deno.test('proxyApi passes a 15 second timeout signal by default', async () => {
  let signal: AbortSignal | null | undefined;
  const fn = ((_input: string | URL | Request, init?: RequestInit) => {
    signal = init?.signal;
    return Promise.resolve(jsonOk());
  }) as typeof fetch;
  const res = await proxyApi(new Request('http://localhost:8787/api/scopes'), CFG, fn);
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assert(signal instanceof AbortSignal && !signal.aborted);
  assertEquals(UPSTREAM_TIMEOUT_MS, 15_000);
});

Deno.test('proxyApi treats an upstream redirect as 502 and never follows it', async () => {
  const { fn, calls } = fakeFetch(() =>
    new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
  );
  const res = await proxyApi(new Request('http://localhost:8787/api/scopes'), CFG, fn);
  assertEquals(res.status, 502);
  assertEquals(await res.json(), { error: 'web-api unreachable' });
  assertEquals(res.headers.get('location'), null);
  assertEquals(calls.length, 1);
});

Deno.test('proxyApi copies only content-type from the upstream headers', async () => {
  const { fn } = fakeFetch(() =>
    new Response('{"ok":true}', {
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer leak',
        'set-cookie': 'sid=1',
        'x-secret': 'v',
      },
    })
  );
  const res = await proxyApi(new Request('http://localhost:8787/api/scopes'), CFG, fn);
  assertEquals(res.headers.get('content-type'), 'application/json');
  assertEquals(res.headers.get('authorization'), null);
  assertEquals(res.headers.get('set-cookie'), null);
  assertEquals(res.headers.get('x-secret'), null);
  await res.body?.cancel();
});

const LOCAL = { host: 'localhost:8787' };

async function withServer(
  fn: (deps: { cfg: Config; staticRoot: string; fetchFn: typeof fetch }, calls: Call[]) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${root}/index.html`, '<h1>app</h1>');
    const { fn: fetchFn, calls } = fakeFetch(jsonOk);
    await fn({ cfg: CFG, staticRoot: root, fetchFn }, calls);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test('handle refuses a foreign Host on every route without reaching a handler', async () => {
  await withServer(async (deps, calls) => {
    for (const path of ['/', '/api/scopes', '/logs/b/l']) {
      const res = await handle(
        new Request(`http://localhost:8787${path}`, { headers: { host: 'evil.example' } }),
        deps,
      );
      assertEquals(res.status, 403, path);
      assertEquals(await res.json(), { error: 'host not allowed' }, path);
    }
    assertEquals(calls.length, 0);
  });
});

Deno.test('handle routes /api to the proxy, /logs to the log reader and the rest to static files', async () => {
  await withServer(async (deps, calls) => {
    const api = await handle(new Request('http://localhost:8787/api/scopes', { headers: LOCAL }), deps);
    assertEquals(api.status, 200);
    assertEquals(await api.json(), { ok: true });
    assertEquals(calls.map((c) => c.url), [`${CFG.apiUrl}/scopes`]);

    const log = await handle(new Request('http://localhost:8787/logs/toy/board-toy-ab12', { headers: LOCAL }), deps);
    assertEquals(log.status, 200);
    assertEquals((await log.json()).found, false);

    const page = await handle(new Request('http://localhost:8787/', { headers: LOCAL }), deps);
    assertEquals(page.status, 200);
    assertEquals(await page.text(), '<h1>app</h1>');

    const missing = await handle(new Request('http://localhost:8787/nope.js', { headers: LOCAL }), deps);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
    assertEquals(calls.length, 1);
  });
});

Deno.test('handle refuses a non-GET method on /logs and on static paths with 405', async () => {
  await withServer(async (deps, calls) => {
    for (const path of ['/logs/toy/board-toy-ab12', '/', '/app.js']) {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const res = await handle(
          new Request(`http://localhost:8787${path}`, { method, headers: LOCAL, body: '{}' }),
          deps,
        );
        assertEquals(res.status, 405, `${method} ${path}`);
        await res.body?.cancel();
      }
    }
    const api = await handle(
      new Request('http://localhost:8787/api/memories', { method: 'POST', headers: LOCAL }),
      deps,
    );
    assertEquals(api.status, 405);
    await api.body?.cancel();
    assertEquals(calls.length, 0);
  });
});

Deno.test('handle adds nosniff and no-store to every kind of response', async () => {
  await withServer(async (deps) => {
    const requests: Request[] = [
      new Request('http://localhost:8787/', { headers: LOCAL }),
      new Request('http://localhost:8787/nope', { headers: LOCAL }),
      new Request('http://localhost:8787/api/scopes', { headers: LOCAL }),
      new Request('http://localhost:8787/api/other', { headers: LOCAL }),
      new Request('http://localhost:8787/logs/toy/board-toy-ab12', { headers: LOCAL }),
      new Request('http://localhost:8787/', { method: 'POST', headers: LOCAL }),
      new Request('http://localhost:8787/', { headers: { host: 'evil.example' } }),
    ];
    for (const req of requests) {
      const res = await handle(req, deps);
      const what = `${req.method} ${new URL(req.url).pathname} ${res.status}`;
      assertEquals(res.headers.get('x-content-type-options'), 'nosniff', what);
      assertEquals(res.headers.get('cache-control'), 'no-store', what);
      await res.body?.cancel();
    }
  });
});

Deno.test('handle keeps the content type of a static file', async () => {
  await withServer(async (deps) => {
    const res = await handle(new Request('http://localhost:8787/', { headers: LOCAL }), deps);
    assertEquals(res.headers.get('content-type'), 'text/html; charset=utf-8');
    await res.body?.cancel();
  });
});

Deno.test('handle turns an unexpected throw into a secured 500 and logs no error text', async () => {
  await withServer(async (deps) => {
    // A response whose status cannot be read makes the proxy throw past its own catch.
    const broken = (() =>
      Promise.resolve(
        {
          get status(): number {
            throw new Error('boom /private/path/to/file');
          },
        } as unknown as Response,
      )) as typeof fetch;
    const logged: unknown[][] = [];
    const real = console.error;
    console.error = (...args: unknown[]) => logged.push(args);
    let res: Response;
    try {
      res = await handle(new Request('http://localhost:8787/api/scopes', { headers: LOCAL }), {
        ...deps,
        fetchFn: broken,
      });
    } finally {
      console.error = real;
    }
    assertEquals(res.status, 500);
    assertEquals(await res.json(), { error: 'internal error' });
    assertEquals(res.headers.get('x-content-type-options'), 'nosniff');
    assertEquals(res.headers.get('cache-control'), 'no-store');
    assertEquals(logged.length, 1);
    assert(!JSON.stringify(logged.map((a) => a.map(String))).includes('/private/path'));
  });
});
