import { assert, assertEquals, assertThrows } from '@std/assert';
import { loadConfig } from '../../web/lib/config.ts';
import { hostAllowed } from '../../web/lib/guard.ts';
import { serveStatic } from '../../web/lib/static.ts';

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
