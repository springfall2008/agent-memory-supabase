import { assert, assertEquals } from '@std/assert';
import { LOG_CHUNK_BYTES, serveLog } from '../../web/lib/logs.ts';

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

const BOARD = 'toy';
const LABEL = 'board-toy-ab12';
const enc = new TextEncoder();

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${home}/${BOARD}/workers`, { recursive: true });
    await fn(home);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
}

const logUrl = (query = '', label = LABEL, board = BOARD) => new URL(`http://localhost/logs/${board}/${label}${query}`);

async function get(home: string, query = '', chunk?: number): Promise<LogBody> {
  const res = await serveLog(logUrl(query), home, chunk);
  assertEquals(res.status, 200);
  return await res.json() as LogBody;
}

const write = (home: string, name: string, content: string | Uint8Array) =>
  Deno.writeFile(
    `${home}/${BOARD}/workers/${name}`,
    typeof content === 'string' ? enc.encode(content) : content,
  );

const state = (home: string, labels: string[]) =>
  Deno.writeTextFile(
    `${home}/${BOARD}/state.json`,
    JSON.stringify({ workers: Object.fromEntries(labels.map((l, i) => [String(i), { label: l }])) }),
  );

const RESULT = '{"type":"result","subtype":"success"}\n';

Deno.test('a transcript is returned whole', async () => {
  await withHome(async (home) => {
    const content = '{"a":1}\n{"b":2}\n' + RESULT;
    await write(home, `0-${LABEL}.jsonl`, content);
    const body = await get(home);
    assertEquals(body, {
      found: true,
      running: false,
      size: content.length,
      start: 0,
      next: content.length,
      text: content,
      cut: false,
    });
  });
});

Deno.test('from returns only later whole lines and next advances', async () => {
  await withHome(async (home) => {
    const content = 'aaaa\nbbbb\ncccc\n' + RESULT;
    await write(home, `0-${LABEL}.jsonl`, content);
    const first = await get(home, '?from=0', 11);
    assertEquals(first.text, 'aaaa\nbbbb\n');
    assertEquals(first.start, 0);
    assertEquals(first.next, 10);
    assertEquals(first.cut, false);
    const second = await get(home, `?from=${first.next}`, 11);
    assertEquals(second.start, 10);
    assertEquals(second.text, 'cccc\n');
    assertEquals(second.next, 15);
  });
});

Deno.test('from at size is empty and next stays at size', async () => {
  await withHome(async (home) => {
    const content = 'aaaa\n' + RESULT;
    await write(home, `0-${LABEL}.jsonl`, content);
    const body = await get(home, `?from=${content.length}`);
    assertEquals(body.text, '');
    assertEquals(body.next, content.length);
    const beyond = await get(home, `?from=${content.length + 500}`);
    assertEquals(beyond.text, '');
    assertEquals(beyond.next, content.length);
  });
});

Deno.test('a cap cut lands on a line end', async () => {
  await withHome(async (home) => {
    await write(home, `0-${LABEL}.jsonl`, 'one\ntwo\nthree\n' + RESULT);
    const body = await get(home, '?from=0', 9);
    assertEquals(body.text, 'one\ntwo\n');
    assertEquals(body.next, 8);
    assertEquals(body.cut, false);
  });
});

Deno.test('tail starts on a line boundary', async () => {
  await withHome(async (home) => {
    const content = 'one\ntwo\nthree\nfour\n' + RESULT;
    await write(home, `0-${LABEL}.jsonl`, content);
    const body = await get(home, '?tail=1', 50);
    assert(body.start > 0);
    assertEquals(content[body.start - 1], '\n');
    assertEquals(body.text, content.slice(body.start));
    assertEquals(body.next, content.length);
    const whole = await get(home, '?tail=1');
    assertEquals(whole.start, 0);
    assertEquals(whole.text, content);
  });
});

Deno.test('before returns the preceding lines', async () => {
  await withHome(async (home) => {
    const content = 'one\ntwo\nthree\nfour\n';
    await write(home, `0-${LABEL}.jsonl`, content);
    const body = await get(home, '?before=14', 9);
    // bytes [5,14) = "wo\nthree\n"; start moves to just after the first newline
    assertEquals(body.start, 8);
    assertEquals(body.next, 14);
    assertEquals(body.text, 'three\n');
    const rest = await get(home, `?before=${body.start}`, 9);
    assertEquals(rest.next, 8);
    assertEquals(rest.text + body.text, content.slice(rest.start, 14));
    const all = await get(home, '?before=14');
    assertEquals(all.start, 0);
    assertEquals(all.text, 'one\ntwo\nthree\n');
  });
});

Deno.test('an over-cap single line is cut and next lies past its end', async () => {
  await withHome(async (home) => {
    const long = 'x'.repeat(50);
    const content = `${long}\nshort\n` + RESULT;
    await write(home, `0-${LABEL}.jsonl`, content);
    const body = await get(home, '?from=0', 20);
    assertEquals(body.cut, true);
    assertEquals(body.text, 'x'.repeat(20));
    assertEquals(body.next, 51);
    const after = await get(home, `?from=${body.next}`, 100);
    assertEquals(after.text, 'short\n' + RESULT);
  });
});

Deno.test('an over-cap line with no newline before end of file ends at size', async () => {
  await withHome(async (home) => {
    await write(home, `0-${LABEL}.jsonl`, 'y'.repeat(30));
    const body = await get(home, '?from=0', 10);
    assertEquals(body.cut, true);
    assertEquals(body.next, 30);
  });
});

Deno.test('an over-cap cut never splits a multibyte character', async () => {
  await withHome(async (home) => {
    const content = 'é'.repeat(20) + '\n';
    await write(home, `0-${LABEL}.jsonl`, content);
    const body = await get(home, '?from=0', 7);
    assertEquals(body.cut, true);
    assertEquals(body.text, 'é'.repeat(3));
    assert(!body.text.includes('�'));
    assertEquals(body.next, enc.encode(content).length);
  });
});

Deno.test('tail of one huge line returns the last bytes from a character boundary', async () => {
  await withHome(async (home) => {
    const content = '€'.repeat(20);
    await write(home, `0-${LABEL}.jsonl`, content);
    const body = await get(home, '?tail=1', 10);
    assertEquals(body.cut, true);
    assert(!body.text.includes('�'));
    assertEquals(body.text, '€'.repeat(3));
    assertEquals(body.next, 60);
    assertEquals(body.start, 60 - 9);
  });
});

Deno.test('before of one huge line returns bytes from a character boundary', async () => {
  await withHome(async (home) => {
    await write(home, `0-${LABEL}.jsonl`, '€'.repeat(20) + '\n');
    const body = await get(home, '?before=61', 10);
    assertEquals(body.cut, true);
    assert(!body.text.includes('�'));
    assertEquals(body.next, 61);
  });
});

Deno.test('following next through non-ASCII text loses and repeats nothing', async () => {
  await withHome(async (home) => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push(JSON.stringify({ i, t: `dash — rocket 🚀 ${'é'.repeat(i % 7)}` }));
    const content = lines.join('\n') + '\n' + RESULT;
    await write(home, `0-${LABEL}.jsonl`, content);
    for (const cap of [64, 100, 257]) {
      let pos = 0;
      let out = '';
      let guard = 0;
      while (guard++ < 1000) {
        const body = await get(home, `?from=${pos}`, cap);
        assertEquals(body.start, pos);
        assert(!body.text.includes('�'));
        out += body.text;
        if (body.next === pos) break;
        pos = body.next;
        if (pos >= body.size) break;
      }
      assertEquals(out, content);
    }
  });
});

Deno.test('following next past an over-cap line yields whole characters and resumes on the next line', async () => {
  await withHome(async (home) => {
    const content = 'start\n' + '🚀'.repeat(30) + '\nend\n';
    await write(home, `0-${LABEL}.jsonl`, content);
    const size = enc.encode(content).length;
    let pos = 0;
    const seen: string[] = [];
    while (pos < size) {
      const body = await get(home, `?from=${pos}`, 16);
      seen.push(body.text);
      assert(body.next > pos);
      pos = body.next;
    }
    assertEquals(seen, ['start\n', '🚀'.repeat(4), 'end\n']);
  });
});

Deno.test('before followed backwards reaches the start with no overlap', async () => {
  await withHome(async (home) => {
    const content = Array.from({ length: 40 }, (_, i) => `line ${i} — 🚀`).join('\n') + '\n';
    await write(home, `0-${LABEL}.jsonl`, content);
    const size = enc.encode(content).length;
    let pos = size;
    let out = '';
    let guard = 0;
    while (pos > 0 && guard++ < 1000) {
      const body = await get(home, `?before=${pos}`, 90);
      assertEquals(body.next, pos);
      assert(body.start < pos);
      out = body.text + out;
      pos = body.start;
    }
    assertEquals(out, content);
  });
});

Deno.test('a trailing partial line is withheld while running and included once not running', async () => {
  await withHome(async (home) => {
    await write(home, `0-${LABEL}.jsonl`, '{"a":1}\n{"b":');
    await state(home, [LABEL]);
    const live = await get(home);
    assertEquals(live.running, true);
    assertEquals(live.text, '{"a":1}\n');
    assertEquals(live.next, 8);
    const liveTail = await get(home, '?tail=1');
    assertEquals(liveTail.text, '{"a":1}\n');
    assertEquals(liveTail.next, 8);

    await Deno.remove(`${home}/${BOARD}/state.json`);
    const done = await get(home);
    assertEquals(done.running, false);
    assertEquals(done.text, '{"a":1}\n{"b":');
    assertEquals(done.next, 13);
  });
});

Deno.test('the .json fallback works and .jsonl wins when both exist', async () => {
  await withHome(async (home) => {
    await write(home, `0-${LABEL}.json`, '{"type":"result"}');
    const old = await get(home);
    assertEquals(old.found, true);
    assertEquals(old.text, '{"type":"result"}');
    await write(home, `0-${LABEL}.jsonl`, 'new\n');
    const fresh = await get(home);
    assertEquals(fresh.text, 'new\n');
  });
});

Deno.test('the newest file by mtime wins', async () => {
  await withHome(async (home) => {
    await write(home, `0-${LABEL}.jsonl`, 'old\n');
    await write(home, `1-${LABEL}.jsonl`, 'new\n');
    await Deno.utime(`${home}/${BOARD}/workers/0-${LABEL}.jsonl`, new Date(2020, 1, 1), new Date(2020, 1, 1));
    assertEquals((await get(home)).text, 'new\n');
    await Deno.utime(`${home}/${BOARD}/workers/1-${LABEL}.jsonl`, new Date(2019, 1, 1), new Date(2019, 1, 1));
    assertEquals((await get(home)).text, 'old\n');
  });
});

Deno.test('a lead label finds its own file and not the worker file', async () => {
  await withHome(async (home) => {
    await write(home, `0-${LABEL}.jsonl`, 'worker\n');
    await write(home, '0-board-toy-lead-ab12.jsonl', 'lead\n');
    const res = await serveLog(logUrl('', 'board-toy-lead-ab12'), home);
    assertEquals((await res.json() as LogBody).text, 'lead\n');
    assertEquals((await get(home)).text, 'worker\n');
  });
});

Deno.test('running needs a state entry and no result line', async () => {
  await withHome(async (home) => {
    await write(home, `0-${LABEL}.jsonl`, '{"type":"assistant"}\n');
    assertEquals((await get(home)).running, false);

    await state(home, [LABEL]);
    assertEquals((await get(home)).running, true);

    await state(home, ['board-toy-ffff']);
    assertEquals((await get(home)).running, false);

    await state(home, [LABEL]);
    await write(home, `0-${LABEL}.jsonl`, '{"type":"assistant"}\n' + RESULT);
    assertEquals((await get(home)).running, false);

    await Deno.writeTextFile(`${home}/${BOARD}/state.json`, 'not json');
    await write(home, `0-${LABEL}.jsonl`, '{"type":"assistant"}\n');
    assertEquals((await get(home)).running, false);
  });
});

Deno.test('running reads the last complete line even when a partial line follows', async () => {
  await withHome(async (home) => {
    await state(home, [LABEL]);
    await write(home, `0-${LABEL}.jsonl`, '{"type":"assistant"}\n' + RESULT + '{"type":"ass');
    assertEquals((await get(home)).running, false);
  });
});

Deno.test('an absent file gives found false', async () => {
  await withHome(async (home) => {
    const body = await get(home);
    assertEquals(body, { found: false, running: false, size: 0, start: 0, next: 0, text: '', cut: false });
  });
  const home = await Deno.makeTempDir();
  try {
    assertEquals((await get(home)).found, false);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test('stderr is the first 16 KiB of the matching .err file, only when non-empty', async () => {
  await withHome(async (home) => {
    await write(home, `0-${LABEL}.jsonl`, 'x\n');
    assertEquals((await get(home)).stderr, undefined);
    await write(home, `0-${LABEL}.err`, '');
    assertEquals((await get(home)).stderr, undefined);
    await write(home, `0-${LABEL}.err`, 'boom\n');
    assertEquals((await get(home)).stderr, 'boom\n');
    await write(home, `0-${LABEL}.err`, 'e'.repeat(20000));
    assertEquals((await get(home)).stderr?.length, 16384);
  });
});

Deno.test('bad names are refused with 400 before any file access', async () => {
  await withHome(async (home) => {
    const cases: Array<[string, string]> = [
      [BOARD, '..%2F..%2Fetc%2Fpasswd'],
      [BOARD, 'board-x-1234%2F..%2F..%2Fy'],
      [BOARD, '*'],
      [BOARD, 'a'.repeat(300)],
      ['..', 'board-..-ab12'],
      [BOARD, 'board-other-ab12'],
      [BOARD, 'board-toy-ABCD'],
      [BOARD, 'board-toy-abc'],
      [BOARD, 'board-toy-abcde'],
      ['%2e%2e', 'board-toy-ab12'],
      ['Toy', 'board-Toy-ab12'],
    ];
    for (const [board, label] of cases) {
      const res = await serveLog(new URL(`http://localhost/logs/${board}/${label}`), home);
      assertEquals(res.status, 400, `${board}/${label}`);
      assertEquals(await res.json(), { error: 'bad name' });
    }
    for (const path of ['/logs/toy', '/logs/toy/board-toy-ab12/extra', '/logs//board-toy-ab12']) {
      const res = await serveLog(new URL(`http://localhost${path}`), home);
      assertEquals(res.status, 400, path);
      await res.body?.cancel();
    }
  });
  // a home that does not exist: a bad name must still be 400, not found:false
  const res = await serveLog(logUrl('', '*'), '/nonexistent/home');
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test('bad queries are refused with 400', async () => {
  await withHome(async (home) => {
    await write(home, `0-${LABEL}.jsonl`, 'x\n');
    for (
      const q of [
        '?from=1&tail=1',
        '?from=1&before=1',
        '?tail=1&before=1',
        '?from=-1',
        '?from=abc',
        '?from=1.5',
        '?from=',
        '?before=-3',
        '?tail=0',
        '?tail=yes',
        '?from=99999999999999999999',
        '?from=1&from=2',
      ]
    ) {
      const res = await serveLog(logUrl(q), home);
      assertEquals(res.status, 400, q);
      assertEquals(await res.json(), { error: 'bad query' });
    }
  });
});

Deno.test('a symlink in workers pointing outside is not served', async () => {
  await withHome(async (home) => {
    const outside = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(`${outside}/secret.jsonl`, 'secret\n');
      await Deno.symlink(`${outside}/secret.jsonl`, `${home}/${BOARD}/workers/0-${LABEL}.jsonl`);
      const res = await serveLog(logUrl(), home);
      const text = await res.text();
      assert(!text.includes('secret'));
      assert(!text.includes(outside));
      assertEquals(JSON.parse(text).found, false);
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

Deno.test('a symlinked stderr pointing outside is not served', async () => {
  await withHome(async (home) => {
    const outside = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(`${outside}/secret.err`, 'secret\n');
      await write(home, `0-${LABEL}.jsonl`, 'x\n');
      await Deno.symlink(`${outside}/secret.err`, `${home}/${BOARD}/workers/0-${LABEL}.err`);
      const body = await get(home);
      assertEquals(body.found, true);
      assertEquals(body.stderr, undefined);
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

Deno.test('the default chunk cap is 256 KiB and bounds the response', async () => {
  assertEquals(LOG_CHUNK_BYTES, 262144);
  await withHome(async (home) => {
    const line = 'z'.repeat(999) + '\n';
    await write(home, `0-${LABEL}.jsonl`, line.repeat(400));
    const body = await get(home);
    assert(enc.encode(body.text).length <= LOG_CHUNK_BYTES);
    assertEquals(body.next, 262000);
    assertEquals(body.size, 400000);
  });
});

Deno.test('while running, an over-cap unterminated line is withheld, then served from a whole-line start', async () => {
  await withHome(async (home) => {
    await state(home, [LABEL]);
    await write(home, `0-${LABEL}.jsonl`, 'a\n' + 'x'.repeat(30));
    const first = await get(home, '?from=2', 20);
    assertEquals(first, { ...first, text: '', start: 2, next: 2, cut: false, running: true, size: 32 });

    await write(home, `0-${LABEL}.jsonl`, 'a\n' + 'x'.repeat(30) + 'yyy\nz\n');
    const second = await get(home, `?from=${first.next}`, 20);
    assertEquals(second.start, 2);
    assertEquals(second.text, 'x'.repeat(20));
    assertEquals(second.cut, true);
    assertEquals(second.next, 2 + 33 + 1);
    const third = await get(home, `?from=${second.next}`, 20);
    assertEquals(third.start, 36);
    assertEquals(third.text, 'z\n');
    assertEquals(third.cut, false);
  });
});

Deno.test('while running, tail with an unterminated last line stops at the last newline', async () => {
  await withHome(async (home) => {
    await state(home, [LABEL]);
    await write(home, `0-${LABEL}.jsonl`, 'p\n'.repeat(20) + 'x'.repeat(10));
    const first = await get(home, '?tail=1', 20);
    assertEquals(first.running, true);
    assertEquals(first.next, 40);
    assert(first.text.endsWith('\n'));
    assert(!first.text.includes('x'));
    assertEquals((await get(home, '?tail=1', 20)).next, 40);

    await write(home, `0-${LABEL}.jsonl`, 'p\n'.repeat(20) + 'x'.repeat(10) + 'yy\n');
    const second = await get(home, `?from=${first.next}`, 20);
    assertEquals(second.start, 40);
    assertEquals(second.text, 'x'.repeat(10) + 'yy\n');
  });
});

Deno.test('while running, tail and before with one huge unterminated line withhold it', async () => {
  await withHome(async (home) => {
    await state(home, [LABEL]);
    await write(home, `0-${LABEL}.jsonl`, 'x'.repeat(100));
    const tailed = await get(home, '?tail=1', 20);
    assertEquals(tailed, { ...tailed, text: '', start: 0, next: 0, cut: false });
    const earlier = await get(home, '?before=100', 20);
    assertEquals(earlier.next, 0);
    assertEquals(earlier.text, '');
  });
});
