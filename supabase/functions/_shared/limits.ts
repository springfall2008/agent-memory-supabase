/** Max memories per store_batch call (CPU budget ~1 s per request). */
export const STORE_BATCH_MAX = 2;
/** Max topics embedded per recall call. */
export const RECALL_EMBED_TOPICS_MAX = 5;
export const DEFAULT_LIMIT = 10;
/** Upper bound for every result limit (search, find_related, list_recent, recall). */
export const MAX_LIMIT = 100;
/** Longest memory content accepted by store, store_batch, update, /embed and import. */
export const MAX_CONTENT_CHARS = 20_000;
/** The store passes `limit * OVER_FETCH_FACTOR` to SQL and trims after decay. */
export const OVER_FETCH_FACTOR = 3;
/** Documentation only: the SQL search functions hard-code k = 60. */
export const RRF_K = 60;
export const ACCESS_TOUCH_INTERVAL_HOURS = 1;
/** Prune defaults, shared by prune and stats.belowPruneThreshold. */
export const PRUNE_MIN_STRENGTH_DEFAULT = 0.05;
export const PRUNE_MAX_DORMANT_DAYS_DEFAULT = 90;

/** A caller error whose message is safe to show the agent as-is. */
export class StoreError extends Error {}

/** Every ranked result limit is an integer in 1..MAX_LIMIT. */
export function checkLimit(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new StoreError(`limit must be between 1 and ${MAX_LIMIT}`);
  }
}

/** Page size cap for unranked browsing (search without a query): no embedding, decay or re-ranking, so it is cheap. */
export const MAX_BROWSE_LIMIT = 400;

/** A browse page size is an integer in 1..MAX_BROWSE_LIMIT. */
export function checkBrowseLimit(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_BROWSE_LIMIT) {
    throw new StoreError(`limit must be between 1 and ${MAX_BROWSE_LIMIT}`);
  }
}

/** Memory links: a memory has at most this many outgoing links (mirrored by the SQL function relate_memories). */
export const MEMORY_LINKS_OUT_MAX = 100;
/** Results show at most this many links per memory, plus a count of the rest. */
export const LINKS_SHOWN_MAX = 10;
export const NEIGHBOURS_MAX_DEPTH = 3;
export const NEIGHBOURS_DEFAULT_DEPTH = 1;
/** `neighbours` returns at most this many memories. */
export const NEIGHBOURS_MAX_RESULTS = 100;
/** `neighbours` with detail 'short' returns this many characters of each memory's content. */
export const NEIGHBOUR_SNIPPET_CHARS = 160;

/** graph: at most this many short nodes (a 160-character snippet each) per call. */
export const GRAPH_MAX_NODES = 400;
/** graph with detail 'full': a memory can hold 20,000 characters, so full content is capped like a ranked read. */
export const GRAPH_FULL_MAX_NODES = MAX_LIMIT;
export const GRAPH_SNIPPET_CHARS = 160;

/** The first `max` characters of `text`, with an ellipsis only when something was cut. */
export function snippet(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** Claims: minutes when none is given, the sanity bound (10 years), and the reason's length. */
export const CLAIM_DEFAULT_MINUTES = 60;
export const CLAIM_MAX_MINUTES = 5_256_000;
export const CLAIM_DESCRIPTION_MAX = 200;
/** `my_claims` returns at most this many claims, each with a snippet of this many characters. */
export const MY_CLAIMS_MAX = 100;
export const CLAIM_SNIPPET_CHARS = 160;

/** A claim lasts 1..CLAIM_MAX_MINUTES whole minutes (mirrored by the SQL function claim_memory). */
export function checkClaimMinutes(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > CLAIM_MAX_MINUTES) {
    throw new StoreError(`minutes must be between 1 and ${CLAIM_MAX_MINUTES}`);
  }
}

/** A neighbour walk goes 1..NEIGHBOURS_MAX_DEPTH hops. */
export function checkDepth(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > NEIGHBOURS_MAX_DEPTH) {
    throw new StoreError(`depth must be between 1 and ${NEIGHBOURS_MAX_DEPTH}`);
  }
}

/** A browse offset is a non-negative integer. */
export function checkOffset(n: number): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new StoreError('offset must be a non-negative integer');
  }
}

/** Rejects content over MAX_CONTENT_CHARS; call before embedding. */
export function checkContent(content: string): void {
  if (content.length > MAX_CONTENT_CHARS) {
    throw new StoreError(`content too long (max ${MAX_CONTENT_CHARS} characters)`);
  }
}

/** Thread limits (mirrored by the SQL functions). */
export const THREAD_TITLE_MAX = 200;
export const THREAD_READ_DEFAULT = 20;
export const THREAD_LINKS_MAX = 20;
export const SESSION_LABEL_MAX = 64;
