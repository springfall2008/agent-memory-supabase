// @ts-check
// A worker log held as the server's byte offsets. The client only compares offsets, it never computes them. No DOM.

/**
 * @typedef {{ start: number; next: number; text: string }} LogBuf `text` covers the bytes from `start` to `next`.
 */

/** @returns {LogBuf} */
export function emptyLog() {
  return { start: 0, next: 0, text: '' };
}

/**
 * Add a chunk the server returned. A forward chunk must begin where the buffer ends and an earlier chunk must end
 * where it begins; anything else (a repeat, an out-of-order reply) leaves the buffer unchanged. An empty buffer takes
 * a forward chunk wherever the server started it, because a tail request starts part way into the file.
 * @param {LogBuf} buf
 * @param {LogBuf} chunk
 * @param {'forward' | 'earlier'} direction
 * @returns {LogBuf}
 */
export function applyChunk(buf, chunk, direction) {
  if (direction === 'forward') {
    const fresh = buf.next === 0 && buf.text === '';
    if (!fresh && chunk.start !== buf.next) return buf;
    return { start: fresh ? chunk.start : buf.start, next: chunk.next, text: buf.text + chunk.text };
  }
  if (chunk.next !== buf.start) return buf;
  return { start: chunk.start, next: buf.next, text: chunk.text + buf.text };
}
