// @ts-check
// git's unified patch as files, hunks and side-by-side rows, the way GitHub's split view draws them. No DOM.

/**
 * @typedef {{ text: string; changed: boolean }} Part
 * @typedef {{ n: number; text: string; kind: 'context' | 'del' | 'add'; parts?: Part[] }} Cell
 * @typedef {{ left: Cell | null; right: Cell | null }} Row
 * @typedef {{ header: string; rows: Row[] }} Hunk
 * @typedef {{
 *   oldPath: string | null;
 *   newPath: string | null;
 *   status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';
 *   adds: number;
 *   dels: number;
 *   hunks: Hunk[];
 *   incomplete: boolean;
 * }} DiffFile
 */

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The two lines of a changed pair as parts: their common prefix and suffix unchanged, the middle changed.
 * @param {string} a the removed line
 * @param {string} b the added line
 * @returns {[Part[], Part[]]}
 */
export function wordParts(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  /** @param {string} s @returns {Part[]} */
  const parts = (s) =>
    [
      { text: s.slice(0, pre), changed: false },
      { text: s.slice(pre, s.length - suf), changed: true },
      { text: s.slice(s.length - suf), changed: false },
    ].filter((p) => p.text !== '');
  return [parts(a), parts(b)];
}

/** @param {string} p a path from a `---`/`+++` line, `/dev/null` meaning none */
function pathOf(p) {
  if (p === '/dev/null') return null;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/**
 * Split git's `show` or `diff` output into what comes before the first file (message, commit list, stat) and the files.
 * Never throws: an unknown line is skipped, and a file whose last hunk is cut short is marked `incomplete`.
 * @param {string} text
 * @returns {{ head: string; files: DiffFile[] }}
 */
export function parsePatch(text) {
  const lines = text.split('\n');
  const headLines = [];
  /** @type {DiffFile[]} */
  const files = [];
  /** @type {DiffFile | null} */
  let file = null;
  /** @type {Hunk | null} */
  let hunk = null;
  let oldN = 0;
  let newN = 0;
  let oldLeft = 0;
  let newLeft = 0;
  /** @type {Cell[]} */
  let dels = [];
  /** @type {Cell[]} */
  let adds = [];

  const flush = () => {
    if (!hunk) return;
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const left = dels[i] ?? null;
      const right = adds[i] ?? null;
      if (left && right) [left.parts, right.parts] = wordParts(left.text, right.text);
      hunk.rows.push({ left, right });
    }
    dels = [];
    adds = [];
  };
  const endFile = () => {
    flush();
    if (file && (oldLeft > 0 || newLeft > 0)) file.incomplete = true;
    hunk = null;
    oldLeft = newLeft = 0;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      endFile();
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = {
        oldPath: m ? m[1] : null,
        newPath: m ? m[2] : null,
        status: 'modified',
        adds: 0,
        dels: 0,
        hunks: [],
        incomplete: false,
      };
      files.push(file);
      continue;
    }
    if (!file) {
      headLines.push(line);
      continue;
    }
    const h = HUNK.exec(line);
    if (h) {
      flush();
      if (oldLeft > 0 || newLeft > 0) file.incomplete = true;
      oldN = Number(h[1]);
      newN = Number(h[3]);
      oldLeft = h[2] === undefined ? 1 : Number(h[2]);
      newLeft = h[4] === undefined ? 1 : Number(h[4]);
      hunk = { header: line, rows: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const body = line.slice(1);
      if (line.startsWith('-')) {
        if (adds.length) flush();
        dels.push({ n: oldN++, text: body, kind: 'del' });
        file.dels++;
        oldLeft--;
        continue;
      }
      if (line.startsWith('+')) {
        adds.push({ n: newN++, text: body, kind: 'add' });
        file.adds++;
        newLeft--;
        continue;
      }
      if (line.startsWith(' ') || line === '') {
        flush();
        hunk.rows.push({
          left: { n: oldN++, text: body, kind: 'context' },
          right: { n: newN++, text: body, kind: 'context' },
        });
        oldLeft--;
        newLeft--;
        continue;
      }
    }
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      file.status = 'renamed';
      file.oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) {
      file.status = 'renamed';
      file.newPath = line.slice('rename to '.length);
    } else if (line.startsWith('Binary files ')) file.status = 'binary';
    else if (line.startsWith('--- ')) file.oldPath = pathOf(line.slice(4));
    else if (line.startsWith('+++ ')) file.newPath = pathOf(line.slice(4));
  }
  endFile();
  // A trailing newline in git's output leaves one empty line that is not part of the head.
  while (headLines.length && headLines[headLines.length - 1] === '') headLines.pop();
  return { head: headLines.join('\n'), files };
}
