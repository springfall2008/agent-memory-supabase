// Fetches JSON from the local server's /api proxy. Every failure becomes an ApiError.

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

/**
 * GET `/api<path>` and parse the JSON body. A non-2xx status throws `ApiError` with the body's `error` text.
 * @param {string} path starts with `/`, query string included
 * @returns {Promise<unknown>}
 */
export async function getJson(path) {
  let res;
  try {
    res = await fetch(`/api${path}`, { headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError(0, 'Network error: the local server is not reachable');
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON: fall through to a status-based message
  }
  if (!res.ok) {
    const text = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new ApiError(res.status, text);
  }
  if (body === null) throw new ApiError(res.status, 'The server sent a response that is not JSON');
  return body;
}

export const NOT_SIGNED_IN = 'Not signed in: check AGENT_MEMORY_TOKEN';
