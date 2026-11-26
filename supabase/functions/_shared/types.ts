// ── Category taxonomy ──────────────────────────────────────────────

export const MEMORY_CATEGORIES = [
  'code-solution',
  'bug-fix',
  'architecture',
  'learning',
  'tool-usage',
  'debugging',
  'performance',
  'security',
  'observation',
  'personal',
  'relationship',
  'other',
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

// ── Domain objects ─────────────────────────────────────────────────

export interface Memory {
  id: string;
  scope: string;
  content: string;
  category: MemoryCategory;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  /** Session labels; omitted when the write named no session. */
  createdSession?: string;
  updatedSession?: string;
  /** Linked threads; set by recall only where links exist. */
  threads?: LinkedThread[];
  /** Visible links to other memories (at most LINKS_SHOWN_MAX); absent when there are none. */
  links?: MemoryLink[];
  /** How many further links exist beyond `links`. */
  moreLinks?: number;
  /** True when a visible `supersedes` link points at this memory. */
  superseded?: true;
  /** The active claim on this memory, if someone is working on it. */
  claim?: MemoryClaim;
}

// ── Claims ─────────────────────────────────────────────────────────

export interface ClaimSession {
  id: string;
  label: string | null;
}

export interface MemoryClaim {
  /** The holder's display name. */
  by: string;
  /** When the claim ends; null for an indefinite claim. */
  until: string | null;
  description: string;
  /** Present, and the session shown, only when the caller holds the claim. */
  mine?: true;
  session?: ClaimSession;
}

export interface ClaimOptions {
  minutes?: number;
  indefinite?: boolean;
  force?: boolean;
}

export interface ClaimResult {
  claimed: true;
  until: string | null;
  /** The claim that `force` replaced; `session` only when it was another session of the caller's own member. */
  overridden?: { by: string; until: string | null; description: string; session?: ClaimSession };
}

/** Which memories claim_next may take: the search filters without dates (tags or tagsAll is required). */
export interface ClaimNextFilters {
  scopes?: string[];
  category?: MemoryCategory;
  tags?: string[];
  tagsAll?: string[];
}

export type ClaimNextResult = { claimed: true; until: string | null; memory: Memory } | { claimed: false };

export interface MyClaim {
  memory: { id: string; scope: string; category: MemoryCategory; tags: string[]; snippet: string };
  description: string;
  claimedAt: string;
  until: string | null;
  session?: ClaimSession;
}

// ── Memory links ───────────────────────────────────────────────────

export const LINK_TYPES = ['relates-to', 'supersedes', 'derived-from', 'depends-on'] as const;
export type LinkType = (typeof LINK_TYPES)[number];
/** `relates-to` has no direction and always reads as `both`. */
export type LinkDirection = 'out' | 'in' | 'both';

export interface MemoryLink {
  type: LinkType;
  direction: LinkDirection;
  /** The memory at the other end (for a walk step: the memory that step reached). */
  memoryId: string;
}

/** Which memories graph returns: the search filters without dates (tags or tagsAll is required). */
export interface GraphFilters {
  scopes?: string[];
  category?: MemoryCategory;
  tags?: string[];
  tagsAll?: string[];
  /** 'short' (default): a snippet per node; 'full': the whole content, with a lower node cap. */
  detail?: 'short' | 'full';
}

export interface GraphNode {
  id: string;
  scope: string;
  category: MemoryCategory;
  tags: string[];
  createdAt: string;
  snippet?: string;
  content?: string;
  superseded?: true;
  claim?: MemoryClaim;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: LinkType;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when more memories matched than were returned (`total` counts them all). */
  truncated: boolean;
  total: number;
}

export interface NeighbourOptions {
  direction?: LinkDirection;
  types?: LinkType[];
  depth?: number;
  scopes?: string[];
}

export interface Neighbour {
  memory: Memory;
  path: MemoryLink[];
}

export interface NeighboursResult {
  neighbours: Neighbour[];
  /** True when the result was cut at the maximum number of memories. */
  truncated: boolean;
}

export interface SearchResult {
  memory: Memory;
  score: number;
}

export interface ScopeInfo {
  scope: string;
  description: string | null;
  access: 'read' | 'write';
  memoryCount: number;
}

export interface MemoryStats {
  totalMemories: number;
  byCategory: Record<string, number>;
  byScope: Record<string, number>;
  oldestMemory: string | null;
  newestMemory: string | null;
  neverAccessed: number;
  belowPruneThreshold: number;
  avgAccessCount: number;
  mostAccessed: { id: string; content: string; count: number }[];
}

export interface PruneOptions {
  scope: string;
  dryRun?: boolean; // default true
  minStrength?: number; // default 0.05
  maxDormantDays?: number; // default 90
}

export interface PruneResult {
  pruned: number;
  inspected: number;
  dryRun: boolean;
  candidates: { id: string; content: string; strength: number; reason: string }[];
}

// ── Request shapes ─────────────────────────────────────────────────

export interface StoreRequest {
  content: string;
  category: MemoryCategory;
  tags: string[];
}

export interface UpdateRequest {
  content?: string;
  category?: MemoryCategory;
  tags?: string[];
  scope?: string;
}

export interface SearchFilters {
  category?: MemoryCategory;
  tags?: string[];
  /** Every one of these tags must be present (tags matches any). */
  tagsAll?: string[];
  after?: string;
  before?: string;
  limit?: number;
  scopes?: string[];
  /** Ranked search counts as an access by default; `false` leaves `access_count` alone (read-only callers). */
  touch?: boolean;
}

/** Filters for unranked browsing: `limit` is the page size and `offset` the number of matches to skip. */
export interface BrowseFilters extends SearchFilters {
  offset?: number;
}

export interface BrowsePage {
  memories: Memory[];
  /** True when at least one more match follows this page. */
  hasMore: boolean;
}

export type SearchMode = 'hybrid' | 'keyword' | 'semantic';

// ── Dependency interfaces ──────────────────────────────────────────

export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedMany(texts: string[]): Promise<number[][]>;
}

export interface MemoryStore {
  listScopes(): Promise<ScopeInfo[]>;
  store(scope: string, r: StoreRequest, s?: SessionRef): Promise<Memory>;
  storeBatch(scope: string, rs: StoreRequest[], s?: SessionRef): Promise<Memory[]>;
  /** `embedding`: precomputed vector; `null` = keyword-only. */
  search(query: string, mode: SearchMode, f: SearchFilters, embedding?: number[] | null): Promise<SearchResult[]>;
  /** Unranked, newest-first listing of everything matching the filters. Does not count as an access. */
  browse(f: BrowseFilters): Promise<BrowsePage>;
  findRelated(id: string, limit: number, scopes?: string[]): Promise<SearchResult[]>;
  relate(from: string, to: string, type: LinkType): Promise<void>;
  unrelate(from: string, to: string, type: LinkType): Promise<boolean>;
  neighbours(id: string, o: NeighbourOptions): Promise<NeighboursResult>;
  graph(f: GraphFilters): Promise<GraphResult>;
  claim(id: string, description: string, o: ClaimOptions, s?: SessionRef): Promise<ClaimResult>;
  release(id: string, force?: boolean, s?: SessionRef): Promise<boolean>;
  myClaims(scopes?: string[]): Promise<MyClaim[]>;
  claimNext(
    f: ClaimNextFilters,
    description: string,
    o: { minutes?: number; indefinite?: boolean },
    s?: SessionRef,
  ): Promise<ClaimNextResult>;
  listRecent(limit: number, category?: MemoryCategory, scopes?: string[]): Promise<Memory[]>;
  update(id: string, u: UpdateRequest, s?: SessionRef): Promise<Memory>;
  delete(id: string): Promise<void>;
  stats(scopes?: string[]): Promise<MemoryStats>;
  prune(o: PruneOptions): Promise<PruneResult>;
}

export interface SessionRef {
  session?: string;
  sessionLabel?: string;
}
export interface SessionInfo {
  id: string;
  label: string | null;
  created: boolean;
}
export type ThreadStatus = 'open' | 'resolved';
export interface ThreadSummary {
  id: string;
  scope: string;
  title: string;
  status: ThreadStatus;
  createdBy: string;
  createdAt: string;
  lastPostAt: string;
  postCount: number;
  lastAuthor: string | null;
}
export interface ThreadPost {
  seq: number;
  kind: 'post' | 'resolve' | 'reopen';
  body: string;
  author: string;
  sessionLabel: string | null;
  createdAt: string;
  new?: boolean;
}
/** preview: first 200 characters of the memory. */
export interface ThreadLink {
  memoryId: string;
  scope: string;
  preview: string;
}
export interface ThreadView {
  thread: ThreadSummary;
  links: ThreadLink[];
  posts: ThreadPost[];
  hasOlder: boolean;
  moreUnread?: boolean;
  session?: SessionInfo;
}
export interface WhatsNewItem {
  threadId: string;
  title: string;
  scope: string;
  status: ThreadStatus;
  newPosts: number;
  lastPostAt: string;
  lastAuthor: string | null;
}
export interface LinkedThread {
  id: string;
  title: string;
  scope: string;
  status: ThreadStatus;
  lastPostAt: string;
}
