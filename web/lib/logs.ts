/** Largest slice of a transcript returned by one request. */
export const LOG_CHUNK_BYTES = 262144;

const STDERR_BYTES = 16384;
const RESULT_TAIL_BYTES = 65536;
const NL = 0x0a;

const BOARD = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HEX4 = /^[0-9a-f]{4}$/;
const DIGITS = /^\d{1,15}$/;

type LogBody = {
  found: boolean;
  running: boolean;
  size: number;
  start: number;
  next: number;
  text: string;
  cut: boolean;
  stderr?: string;
};

type Slice = { start: number; textEnd: number; next: number; cut: boolean };

const NOT_FOUND: LogBody = { found: false, running: false, size: 0, start: 0, next: 0, text: '', cut: false };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const badName = () => json({ error: 'bad name' }, 400);
const badQuery = () => json({ error: 'bad query' }, 400);

function validLabel(board: string, label: string): boolean {
  const prefix = `board-${board}-`;
  if (!label.startsWith(prefix)) return false;
  const rest = label.slice(prefix.length);
  return HEX4.test(rest) || (rest.startsWith('lead-') && HEX4.test(rest.slice(5)));
}

const isContinuation = (b: number) => (b & 0xc0) === 0x80;

/** Length of the longest prefix of `buf` that does not end inside a UTF-8 sequence. */
export function wholeChars(buf: Uint8Array): number {
  for (let back = 1; back <= Math.min(4, buf.length); back++) {
    const i = buf.length - back;
    const b = buf[i];
    if (isContinuation(b)) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return i + need > buf.length ? i : buf.length;
  }
  return buf.length;
}

/** Offset of the first byte at or after `from` that begins a character. */
function charStart(buf: Uint8Array, from: number): number {
  let i = from;
  while (i < buf.length && i - from < 3 && isContinuation(buf[i])) i++;
  return i;
}

async function readAt(file: Deno.FsFile, pos: number, len: number): Promise<Uint8Array> {
  const buf = new Uint8Array(Math.max(0, len));
  await file.seek(pos, Deno.SeekMode.Start);
  let got = 0;
  while (got < buf.length) {
    const n = await file.read(buf.subarray(got));
    if (n === null) break;
    got += n;
  }
  return buf.subarray(0, got);
}

/** Position just past the first newline at or after `from`, or `size` when there is none. */
async function pastLineEnd(file: Deno.FsFile, from: number, size: number, cap: number): Promise<number> {
  for (let pos = from; pos < size; pos += cap) {
    const buf = await readAt(file, pos, Math.min(cap, size - pos));
    const i = buf.indexOf(NL);
    if (i >= 0) return pos + i + 1;
  }
  return size;
}

/** Position just after the last newline in the file, or 0 when it has none. */
async function lastLineEnd(file: Deno.FsFile, size: number): Promise<number> {
  for (let end = size; end > 0;) {
    const from = Math.max(0, end - RESULT_TAIL_BYTES);
    const i = (await readAt(file, from, end - from)).lastIndexOf(NL);
    if (i >= 0) return from + i + 1;
    end = from;
  }
  return 0;
}

/**
 * Forward chunk from `start`, never past `eof`: whole lines, except a single line longer than the cap.
 * `eof` is the end of the readable region, so a line still being written is never reached.
 */
async function forward(file: Deno.FsFile, eof: number, start: number, cap: number): Promise<Slice> {
  const end = Math.min(start + cap, eof);
  const buf = await readAt(file, start, end - start);
  if (end === eof) return { start, textEnd: end, next: end, cut: false };
  const nl = buf.lastIndexOf(NL);
  if (nl >= 0) return { start, textEnd: start + nl + 1, next: start + nl + 1, cut: false };
  const textEnd = start + wholeChars(buf);
  return { start, textEnd, next: await pastLineEnd(file, end, eof, cap), cut: true };
}

async function tail(file: Deno.FsFile, eof: number, cap: number): Promise<Slice> {
  const windowStart = Math.max(0, eof - cap);
  if (windowStart === 0) return await forward(file, eof, 0, cap);
  const buf = await readAt(file, windowStart, eof - windowStart);
  const nl = buf.indexOf(NL);
  if (nl >= 0 && windowStart + nl + 1 < eof) return await forward(file, eof, windowStart + nl + 1, cap);
  return { start: windowStart + charStart(buf, 0), textEnd: eof, next: eof, cut: true };
}

async function before(file: Deno.FsFile, n: number, cap: number): Promise<Slice> {
  const windowStart = Math.max(0, n - cap);
  const buf = await readAt(file, windowStart, n - windowStart);
  if (windowStart === 0) return { start: 0, textEnd: n, next: n, cut: false };
  const nl = buf.indexOf(NL);
  if (nl >= 0 && windowStart + nl + 1 < n) return { start: windowStart + nl + 1, textEnd: n, next: n, cut: false };
  return { start: windowStart + charStart(buf, 0), textEnd: n, next: n, cut: true };
}

const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

async function realInside(dir: string, path: string): Promise<string | null> {
  try {
    const target = await Deno.realPath(path);
    if (!target.startsWith(`${dir}/`)) return null;
    return (await Deno.stat(target)).isFile ? target : null;
  } catch {
    return null;
  }
}

/** The newest transcript for `label` inside `dir` (a real path), preferring .jsonl over the older .json. */
async function findTranscript(dir: string, label: string): Promise<{ base: string; path: string } | null> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  } catch {
    return null;
  }
  for (const ext of ['.jsonl', '.json']) {
    const suffix = `-${label}${ext}`;
    let best: { base: string; path: string; mtime: number } | null = null;
    for (const name of names.filter((n) => n.endsWith(suffix))) {
      const path = await realInside(dir, `${dir}/${name}`);
      if (path === null) continue;
      const mtime = (await Deno.stat(path)).mtime?.getTime() ?? 0;
      if (best === null || mtime > best.mtime) best = { base: name.slice(0, -ext.length), path, mtime };
    }
    if (best !== null) return best;
  }
  return null;
}

function isResultLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null && parsed.type === 'result';
  } catch {
    return false;
  }
}

/**
 * Whether the runner's state lists `label` as a running worker. No state file means not listed. A state file that
 * exists but cannot be read or parsed counts as listed: "running" only withholds the unfinished last line, so guessing
 * running is the safe side.
 */
async function listedRunning(boardDir: string, label: string): Promise<boolean> {
  let text: string;
  try {
    text = await Deno.readTextFile(`${boardDir}/state.json`);
  } catch (err) {
    return !(err instanceof Deno.errors.NotFound);
  }
  try {
    const workers = JSON.parse(text)?.workers;
    if (typeof workers !== 'object' || workers === null) return false;
    return Object.values(workers).some((w) => (w as { label?: unknown } | null)?.label === label);
  } catch {
    return true;
  }
}

/** True when the last complete line of the transcript's tail is the stream's `result` event. */
async function finished(file: Deno.FsFile, size: number): Promise<boolean> {
  const from = Math.max(0, size - RESULT_TAIL_BYTES);
  const lines = decode(await readAt(file, from, size - from)).split('\n');
  let i = lines.length - 1;
  if (lines[i] !== '') {
    if (isResultLine(lines[i])) return true;
    i--;
  }
  while (i >= 0 && lines[i].trim() === '') i--;
  return i >= 0 && isResultLine(lines[i]);
}

async function readStderr(dir: string, base: string): Promise<string | undefined> {
  const path = await realInside(dir, `${dir}/${base}.err`);
  if (path === null) return undefined;
  try {
    using file = await Deno.open(path, { read: true });
    const buf = await readAt(file, 0, STDERR_BYTES);
    const text = decode(buf.subarray(0, wholeChars(buf)));
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * Serve `GET /logs/<board>/<label>`: a byte-exact slice of a worker transcript.
 * Offsets are bytes into the file, so a client can chain `next` and `start` without gaps or overlaps.
 */
export async function serveLog(url: URL, runnerHome: string, chunkBytes = LOG_CHUNK_BYTES): Promise<Response> {
  const parts = url.pathname.split('/');
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== 'logs') return badName();
  let board: string;
  let label: string;
  try {
    board = decodeURIComponent(parts[2]);
    label = decodeURIComponent(parts[3]);
  } catch {
    return badName();
  }
  if (!BOARD.test(board) || !validLabel(board, label)) return badName();

  const params = url.searchParams;
  const given = ['from', 'tail', 'before'].filter((k) => params.has(k));
  if (given.length > 1) return badQuery();
  const mode = given[0] ?? 'from';
  const raw = params.get(mode) ?? '0';
  if (params.getAll(mode).length > 1) return badQuery();
  if (mode === 'tail' ? raw !== '1' : !DIGITS.test(raw)) return badQuery();
  const offset = mode === 'tail' ? 0 : Number(raw);

  const boardDir = `${runnerHome}/${board}`;
  let dir: string;
  try {
    dir = await Deno.realPath(`${boardDir}/workers`);
  } catch {
    return json(NOT_FOUND);
  }
  const found = await findTranscript(dir, label);
  if (found === null) return json(NOT_FOUND);

  try {
    using file = await Deno.open(found.path, { read: true });
    // Read the state before the size: a worker not listed by then has written everything the file will hold.
    const listed = await listedRunning(boardDir, label);
    const size = (await file.stat()).size;
    const running = listed && !(await finished(file, size));
    // While running, the last unterminated line is still being written, so no offset may point into it.
    const eof = running ? await lastLineEnd(file, size) : size;
    const clamped = Math.min(offset, eof);
    const slice = mode === 'tail'
      ? await tail(file, eof, chunkBytes)
      : mode === 'before'
      ? await before(file, clamped, chunkBytes)
      : await forward(file, eof, clamped, chunkBytes);
    const text = decode(await readAt(file, slice.start, slice.textEnd - slice.start));
    const body: LogBody = { found: true, running, size, start: slice.start, next: slice.next, text, cut: slice.cut };
    const stderr = await readStderr(dir, found.base);
    if (stderr !== undefined) body.stderr = stderr;
    return json(body);
  } catch {
    return json(NOT_FOUND);
  }
}
