// A board commit's diff, from the board runner's workspace on this machine. Local only, like the worker logs: the
// workspace path comes from the runner's state.json, and git runs without a shell, external diff tools or a pager.
import { wholeChars } from './logs.ts';

/** Most bytes of diff text returned; more is cut at a whole character and marked `truncated`. */
export const DIFF_MAX_BYTES = 2 * 1024 * 1024;
export const DIFF_TIMEOUT_MS = 10_000;

const BOARD = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SHA = /^[0-9a-f]{7,40}$/;
/** Where "All changes vs main" starts: the first of these that names a commit. */
const BASES = ['origin/HEAD', 'origin/main', 'main', 'master'];
/**
 * Before any subcommand: no pager, no colour, no configured diff drivers, and no signature checks. Workers can write
 * the workspace's .git/config, and `log.showSignature` with `gpg.program` would otherwise run a program of theirs.
 */
const GLOBAL = [
  '--no-pager',
  '-c',
  'core.pager=cat',
  '-c',
  'color.ui=false',
  '-c',
  'diff.external=',
  '-c',
  'log.showSignature=false',
];

export type GitResult = { code: number; out: Uint8Array; timedOut: boolean };
export type GitRunner = (cwd: string, args: string[], timeoutMs: number) => Promise<GitResult>;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** Run git in `cwd`, keeping at most DIFF_MAX_BYTES + 1 bytes of stdout and killing it at the timeout. */
export const gitRunner: GitRunner = async (cwd, args, timeoutMs) => {
  const child = new Deno.Command('git', {
    args: ['-C', cwd, ...args],
    stdin: 'null',
    stdout: 'piped',
    stderr: 'null',
    // No prompts, no lock files, and no fetch from a promisor remote the repository's config chooses.
    env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' },
  }).spawn();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGKILL');
    } catch { /* already gone */ }
  }, timeoutMs);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = child.stdout.getReader();
  try {
    while (size <= DIFF_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    if (size > DIFF_MAX_BYTES) {
      try {
        child.kill('SIGKILL');
      } catch { /* already gone */ }
    }
  } finally {
    reader.releaseLock();
    await child.stdout.cancel().catch(() => {});
  }
  const status = await child.status;
  clearTimeout(timer);
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return { code: size > DIFF_MAX_BYTES ? 0 : status.code, out, timedOut };
};

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** The workspace the board's runner recorded, or null. */
async function workspaceOf(runnerHome: string, board: string): Promise<string | null> {
  try {
    const state = JSON.parse(await Deno.readTextFile(`${runnerHome}/${board}/state.json`));
    const ws = state?.workspace;
    if (typeof ws !== 'string' || ws === '') return null;
    return (await Deno.stat(ws)).isDirectory ? ws : null;
  } catch {
    return null;
  }
}

class Stop extends Error {
  constructor(readonly response: Response) {
    super('stop');
  }
}

/**
 * GET /diff/<board>/<sha>?view=commit|main: `git show <sha>` (default), or every change on top of the base branch
 * (`git diff <base>...<sha>`) with the commit list. Anything that is not exactly the expected shape is a 400 before git
 * runs.
 */
export async function serveDiff(url: URL, runnerHome: string, run: GitRunner = gitRunner): Promise<Response> {
  const parts = url.pathname.split('/').slice(2);
  const view = url.searchParams.get('view') ?? 'commit';
  if (parts.length !== 2 || !BOARD.test(parts[0]) || !SHA.test(parts[1]) || (view !== 'commit' && view !== 'main')) {
    return json({ error: 'bad request' }, 400);
  }
  const [board, sha] = parts;
  const ws = await workspaceOf(runnerHome, board);
  if (ws === null) return json({ error: 'No workspace recorded for this board: restart its board-runner' }, 404);

  const git = async (...args: string[]) => {
    const r = await run(ws, [...GLOBAL, ...args], DIFF_TIMEOUT_MS);
    if (r.timedOut) throw new Stop(json({ error: 'git took too long' }, 504));
    return r;
  };
  try {
    const kind = await git('cat-file', '-t', sha);
    if (kind.code !== 0 || decode(kind.out).trim() !== 'commit') {
      return json({ error: `Commit ${sha} is not in this board's workspace` }, 404);
    }
    let base: string | null = null;
    let head = '';
    let body: GitResult;
    if (view === 'commit') {
      body = await git('show', '--no-ext-diff', '--no-textconv', '--stat', '--patch', '--format=fuller', sha);
    } else {
      for (const b of BASES) {
        if ((await git('rev-parse', '--verify', '--quiet', `${b}^{commit}`)).code === 0) {
          base = b;
          break;
        }
      }
      if (base === null) return json({ error: "No main branch found in this board's workspace" }, 404);
      head = `Commits on top of ${base}:\n${decode((await git('log', '--oneline', `${base}..${sha}`)).out)}\n`;
      body = await git('diff', '--no-ext-diff', '--no-textconv', '--stat', '--patch', `${base}...${sha}`);
    }
    if (body.code !== 0) return json({ error: 'git could not show this commit' }, 500);
    const top = new TextEncoder().encode(head);
    const all = new Uint8Array(top.length + body.out.length);
    all.set(top);
    all.set(body.out, top.length);
    const truncated = all.length > DIFF_MAX_BYTES;
    const kept = truncated ? all.subarray(0, wholeChars(all.subarray(0, DIFF_MAX_BYTES))) : all;
    return json({ sha, view, base, text: decode(kept), truncated });
  } catch (e) {
    if (e instanceof Stop) return e.response;
    throw e;
  }
}
