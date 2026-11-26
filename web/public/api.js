// Fetches and posts JSON through the local server's /api proxy. Every failure becomes an ApiError.

export class ApiError extends Error {
  /**
   * @param {number} status the HTTP status, or 0 when the request never got a response
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** How long a request may take before it fails like a network error. The server gives up on web-api at 15 s. */
export const REQUEST_TIMEOUT_MS = 20000;

/** A write waits longer: the server gives up on web-api at 30 s for a POST. */
export const POST_TIMEOUT_MS = 35000;

/**
 * GET `/api<path>` and parse the JSON body. A non-2xx status throws `ApiError` with the body's `error` text. A request
 * with no answer after `REQUEST_TIMEOUT_MS`, or aborted through `signal`, throws an `ApiError` with status 0.
 * @param {string} path starts with `/`, query string included
 * @param {AbortSignal} [signal] aborts the request, for a caller that has moved on
 * @returns {Promise<unknown>}
 */
export function getJson(path, signal) {
  return request(path, { headers: { accept: 'application/json' } }, REQUEST_TIMEOUT_MS, signal);
}

/**
 * POST `body` as JSON to `/api<path>` and parse the JSON answer, failing as `getJson` does, after `POST_TIMEOUT_MS`.
 * The page's own origin makes the browser send `Sec-Fetch-Site: same-origin`, which the local server requires.
 * @param {string} path starts with `/`
 * @param {unknown} body
 * @param {AbortSignal} [signal]
 * @returns {Promise<unknown>}
 */
export function postJson(path, body, signal) {
  return request(
    path,
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    POST_TIMEOUT_MS,
    signal,
  );
}

/**
 * @param {string} path
 * @param {RequestInit} init
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 * @returns {Promise<unknown>}
 */
async function request(path, init, timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const failed = () =>
    new ApiError(
      0,
      signal?.aborted
        ? 'Request cancelled'
        : timeout.aborted
        ? 'Timed out: the local server did not answer'
        : 'Network error: the local server is not reachable',
    );
  let res;
  try {
    res = await fetch(`/api${path}`, { ...init, signal: both });
  } catch {
    throw failed();
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // An abort while reading the body is a failed request; otherwise the body is not JSON.
    if (both.aborted) throw failed();
  }
  if (!res.ok) {
    const text = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new ApiError(res.status, text);
  }
  if (body === null) throw new ApiError(res.status, 'The server sent a response that is not JSON');
  return body;
}

export const NOT_SIGNED_IN = 'Not signed in: check AGENT_MEMORY_TOKEN';
