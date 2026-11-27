import { assert, assertEquals } from '@std/assert';
import { DIFF_MAX_BYTES, type GitRunner, gitRunner, serveDiff } from '../../web/lib/diff.ts';
import { handle } from '../../web/server.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const SHA = 'faf6fed5';

/** A runner home with one board whose state names `workspace` (or no state at all). */
async function withHome(fn: (home: string, ws: string) => Promise<void>, state?: Record<string, unknown>) {
  const home = await Deno.makeTempDir();
  const ws = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${home}/toy`);
    if (state !== undefined) await Deno.writeTextFile(`${home}/toy/state.json`, JSON.stringify(state));
    await fn(home, ws);
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(ws, { recursive: true });
  }
}

/** A fake git: `answers` maps the subcommand (first arg after the global flags) to its result. */
function fakeGit(answers: Record<string, { code?: number; out?: string | Uint8Array; timedOut?: boolean }>) {
  const calls: { cwd: string; args: string[] }[] = [];
  const run: GitRunner = (cwd, args) => {
    calls.push({ cwd, args });
    const sub = args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? '';
    const key = sub === 'rev-parse' ? `rev-parse ${args[args.length - 1]}` : sub;
    const a = answers[key] ?? { code: 1, out: '' };
    const out = typeof a.out === 'string' ? enc(a.out) : a.out ?? new Uint8Array();
    return Promise.resolve({ code: a.code ?? 0, out, timedOut: a.timedOut ?? false });
  };
  return { run, calls };
}

const get = (path: string, home: string, run: GitRunner) =>
  serveDiff(new URL(`http://localhost:8787${path}`), home, run);

Deno.test('serveDiff refuses a bad board, SHA or view without running git', async () => {
  await withHome(async (home) => {
    const { run, calls } = fakeGit({});
    for (
      const path of [
        '/diff/Toy/faf6fed5',
        '/diff/toy/FAF6FED5',
        '/diff/toy/faf6',
        '/diff/toy/faf6fed5;rm',
        '/diff/toy/--output=x',
        '/diff/toy/faf6fed5/extra',
        '/diff/toy/faf6fed5?view=all',
      ]
    ) {
      const r = await get(path, home, run);
      assertEquals(r.status, 400, path);
      await r.body?.cancel();
    }
    assertEquals(calls, []);
  }, { workspace: '/nowhere' });
});

Deno.test('serveDiff says to restart the runner when no workspace is recorded', async () => {
  for (const state of [undefined, { lead_label: 'x' }]) {
    await withHome(async (home) => {
      const { run, calls } = fakeGit({});
      const r = await get(`/diff/toy/${SHA}`, home, run);
      assertEquals(r.status, 404);
      assertEquals(await r.json(), { error: 'No workspace recorded for this board: restart its board-runner' });
      assertEquals(calls, []);
    }, state);
  }
});

Deno.test('serveDiff answers 404 for a SHA that is not a commit', async () => {
  await withHome(async (home, ws) => {
    await Deno.writeTextFile(`${home}/toy/state.json`, JSON.stringify({ workspace: ws }));
    const { run } = fakeGit({ 'cat-file': { out: 'blob\n' } });
    const r = await get(`/diff/toy/${SHA}`, home, run);
    assertEquals(r.status, 404);
    assertEquals((await r.json()).error, `Commit ${SHA} is not in this board's workspace`);
  });
});

Deno.test('serveDiff shows one commit with the safety flags, in the recorded workspace', async () => {
  await withHome(async (home, ws) => {
    await Deno.writeTextFile(`${home}/toy/state.json`, JSON.stringify({ workspace: ws }));
    const { run, calls } = fakeGit({ 'cat-file': { out: 'commit\n' }, show: { out: 'commit faf6fed5\n+added\n' } });
    const r = await get(`/diff/toy/${SHA}`, home, run);
    assertEquals(r.status, 200);
    assertEquals(await r.json(), {
      sha: SHA,
      view: 'commit',
      base: null,
      text: 'commit faf6fed5\n+added\n',
      truncated: false,
    });
    const show = calls.find((c) => c.args.includes('show'))!;
    assertEquals(show.cwd, ws);
    for (const flag of ['--no-pager', '--no-ext-diff', '--no-textconv', 'core.pager=cat']) {
      assert(show.args.includes(flag), flag);
    }
    assertEquals(show.args[show.args.length - 1], SHA);
  });
});

Deno.test('serveDiff compares with the first base that exists, listing the commits', async () => {
  await withHome(async (home, ws) => {
    await Deno.writeTextFile(`${home}/toy/state.json`, JSON.stringify({ workspace: ws }));
    const { run, calls } = fakeGit({
      'cat-file': { out: 'commit\n' },
      'rev-parse origin/HEAD^{commit}': { code: 1 },
      'rev-parse origin/main^{commit}': { code: 0, out: 'abc\n' },
      log: { out: 'faf6fed5 one\n' },
      diff: { out: '+x\n' },
    });
    const r = await get(`/diff/toy/${SHA}?view=main`, home, run);
    assertEquals(r.status, 200);
    const body = await r.json();
    assertEquals([body.view, body.base, body.truncated], ['main', 'origin/main', false]);
    assertEquals(body.text, 'Commits on top of origin/main:\nfaf6fed5 one\n\n+x\n');
    const diff = calls.find((c) => c.args.includes('diff'))!;
    assertEquals(diff.args[diff.args.length - 1], `origin/main...${SHA}`);
  });
});

Deno.test('serveDiff cuts a huge diff at a whole character and says so; a timeout is 504', async () => {
  await withHome(async (home, ws) => {
    await Deno.writeTextFile(`${home}/toy/state.json`, JSON.stringify({ workspace: ws }));
    const big = new Uint8Array(DIFF_MAX_BYTES + 10).fill(0x61);
    big.set(enc('é'), DIFF_MAX_BYTES - 1); // a two-byte character across the cut
    const { run } = fakeGit({ 'cat-file': { out: 'commit\n' }, show: { out: big } });
    const body = await (await get(`/diff/toy/${SHA}`, home, run)).json();
    assertEquals(body.truncated, true);
    assertEquals(enc(body.text).length, DIFF_MAX_BYTES - 1);
    const slow = fakeGit({ 'cat-file': { out: 'commit\n' }, show: { timedOut: true } });
    const r = await get(`/diff/toy/${SHA}`, home, slow.run);
    assertEquals(r.status, 504);
    await r.body?.cancel();
  });
});

Deno.test('serveDiff against a real repository shows both views', async () => {
  await withHome(async (home, ws) => {
    const git = (...args: string[]) => new Deno.Command('git', { args: ['-C', ws, ...args] }).output();
    await git('init', '-q', '-b', 'main');
    await git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base');
    await git('switch', '-q', '-c', 'board/toy/ab12');
    await Deno.writeTextFile(`${ws}/a.txt`, 'one\n');
    await git('add', 'a.txt');
    await git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'add a');
    const sha = new TextDecoder().decode((await git('rev-parse', '--short=8', 'HEAD')).stdout).trim();
    await Deno.writeTextFile(`${home}/toy/state.json`, JSON.stringify({ workspace: ws }));
    const one = await (await get(`/diff/toy/${sha}`, home, gitRunner)).json();
    assert(one.text.includes('+one'), one.text);
    assert(one.text.includes('add a'), one.text);
    const all = await (await get(`/diff/toy/${sha}?view=main`, home, gitRunner)).json();
    assertEquals(all.base, 'main');
    assert(all.text.startsWith('Commits on top of main:\n'), all.text);
    assert(all.text.includes('+one'), all.text);
  });
});

Deno.test('the server routes GET /diff/ to the diff reader and refuses other methods', async () => {
  await withHome(async (home) => {
    const cfg = { apiUrl: 'https://x.example/functions/v1/web-api', token: 't', runnerHome: home, port: 8787 };
    const deps = { cfg, staticRoot: home };
    const headers = { host: 'localhost:8787' };
    const r = await handle(new Request(`http://localhost:8787/diff/toy/${SHA}`, { headers }), deps);
    assertEquals(r.status, 404);
    assertEquals((await r.json()).error, 'No workspace recorded for this board: restart its board-runner');
    const p = await handle(new Request(`http://localhost:8787/diff/toy/${SHA}`, { method: 'POST', headers }), deps);
    assertEquals(p.status, 405);
    await p.body?.cancel();
  });
});
