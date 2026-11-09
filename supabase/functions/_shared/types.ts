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
  findRelated(id: string, limit: number, scopes?: string[]): Promise<SearchResult[]>;
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
