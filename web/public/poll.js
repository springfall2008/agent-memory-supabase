// @ts-check
// Poll timing: a steady interval, backing off while requests fail. No DOM.

export const POLL_MS = 3000;
const MAX_MS = 30000;

/**
 * The delay before the next poll: `POLL_MS` after a success. After a failure, a delay below `POLL_MS` becomes
 * `POLL_MS` and anything else doubles, capped at 30 seconds.
 * @param {number} current
 * @param {boolean} ok
 * @returns {number}
 */
export function nextDelay(current, ok) {
  if (ok) return POLL_MS;
  return current < POLL_MS ? POLL_MS : Math.min(MAX_MS, current * 2);
}

/** A live loop that has not refreshed for this long says `stale`: its request may be hanging. */
export const STALE_MS = 3 * POLL_MS;

/**
 * What the strip shows for the connection: `stale` in place of `live` once the last refresh is over `STALE_MS` old.
 * @template {string} C
 * @param {C} conn
 * @param {Date | null} refreshed
 * @param {number} now
 * @returns {C | 'stale'}
 */
export function connState(conn, refreshed, now) {
  if (conn !== 'live' || refreshed === null) return conn;
  return now - refreshed.getTime() > STALE_MS ? 'stale' : conn;
}
