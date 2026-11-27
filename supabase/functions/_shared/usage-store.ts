// Board usage: raw token counts per board run, written by the board runner and read by the web UI. Every query runs
// as the member; the rules (who may write, which intent id is kept, the limits) live in the SQL functions.
import type postgres from 'npm:postgres@3.4.5';
import { type Sql, withMember } from './db.ts';
import { StoreError } from './limits.ts';

type Tx = postgres.TransactionSql;
type Row = Record<string, unknown>;

export const USAGE_ROLES = ['worker', 'lead', 'start', 'release'] as const;
export type UsageRole = (typeof USAGE_ROLES)[number];

export interface ModelTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One run's counts, as the runner sends them. Timestamps are ISO-8601 strings. */
export interface UsageRow {
  scope: string;
  board: string;
  runLabel: string;
  role: UsageRole;
  intentId: string | null;
  outcome: string | null;
  runnerModel: string;
  tokens: ModelTokens;
  turns: number | null;
  durationMs: number | null;
  models: Record<string, ModelTokens>;
  startedAt: string | null;
  endedAt: string | null;
}

export interface StoredUsage extends UsageRow {
  id: string;
  /** The member id that recorded the run. */
  recordedBy: string;
  updatedAt: string;
}

export interface BoardUsage {
  runs: StoredUsage[];
  /** Summed over every run of the board, including any past the returned page. */
  total: ModelTokens;
  more: boolean;
}

export interface UsageStore {
  record(r: UsageRow): Promise<string>;
  forBoard(scope: string, board: string): Promise<BoardUsage>;
  deleteBoard(scope: string, board: string): Promise<number>;
}

/** How many runs `forBoard` returns, newest first. */
export const USAGE_PAGE = 1000;

// Timestamps travel as text so they round-trip exactly.
const iso = (col: string) => `to_char(${col} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export class PgUsageStore implements UsageStore {
  constructor(private readonly sql: Sql, private readonly memberId: string) {}

  /** Postgres rule texts (P0001) are user-safe and pass through; anything else is logged and hidden. */
  private async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await withMember(this.sql, this.memberId, fn);
    } catch (e) {
      if (e instanceof StoreError) throw e;
      const err = e as { code?: string; message?: string };
      if (err.code === 'P0001') throw new StoreError(err.message ?? 'Database error');
      console.error('database error', err.code, err.message);
      throw new StoreError('Database error');
    }
  }

  record(r: UsageRow): Promise<string> {
    return this.run(async (tx) => {
      const [row] = await tx<Row[]>`
        select agent_memory.record_board_usage(
          ${r.scope}::text, ${r.board}::text, ${r.runLabel}::text, ${r.role}::text, ${r.intentId}::text,
          ${r.outcome}::text, ${r.runnerModel}::text, ${r.tokens.input}::bigint, ${r.tokens.output}::bigint,
          ${r.tokens.cacheRead}::bigint, ${r.tokens.cacheWrite}::bigint, ${r.turns}::int, ${r.durationMs}::bigint,
          ${JSON.stringify(r.models)}::text::jsonb, ${r.startedAt}::text, ${r.endedAt}::text) as id`;
      return row.id as string;
    });
  }

  forBoard(scope: string, board: string): Promise<BoardUsage> {
    return this.run(async (tx) => {
      // The select policy hides rows of scopes the caller cannot read, so an unreadable scope is just empty.
      const rows = await tx<Row[]>`
        select u.id, u.board, u.run_label, u.role, u.intent_id, u.outcome, u.runner_model,
               u.input_tokens::text as input, u.output_tokens::text as output,
               u.cache_read_tokens::text as cache_read, u.cache_write_tokens::text as cache_write,
               u.turns, u.duration_ms::text as duration_ms, u.models, u.recorded_by,
               ${tx.unsafe(iso('u.started_at'))} as started_at, ${tx.unsafe(iso('u.ended_at'))} as ended_at,
               ${tx.unsafe(iso('u.updated_at'))} as updated_at
        from agent_memory.board_usage u join agent_memory.scopes s on s.id = u.scope_id
        where s.name = ${scope} and u.board = ${board}
        order by u.updated_at desc, u.run_label
        limit ${USAGE_PAGE + 1}`;
      const [sum] = await tx<Row[]>`
        select coalesce(sum(u.input_tokens), 0)::text as input, coalesce(sum(u.output_tokens), 0)::text as output,
               coalesce(sum(u.cache_read_tokens), 0)::text as cache_read,
               coalesce(sum(u.cache_write_tokens), 0)::text as cache_write
        from agent_memory.board_usage u join agent_memory.scopes s on s.id = u.scope_id
        where s.name = ${scope} and u.board = ${board}`;
      const runs = rows.slice(0, USAGE_PAGE).map((r): StoredUsage => ({
        id: r.id as string,
        scope,
        board: r.board as string,
        runLabel: r.run_label as string,
        role: r.role as UsageRole,
        intentId: (r.intent_id as string | null) ?? null,
        outcome: (r.outcome as string | null) ?? null,
        runnerModel: r.runner_model as string,
        tokens: tokensOf(r),
        turns: (r.turns as number | null) ?? null,
        durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
        models: r.models as Record<string, ModelTokens>,
        startedAt: (r.started_at as string | null) ?? null,
        endedAt: (r.ended_at as string | null) ?? null,
        recordedBy: r.recorded_by as string,
        updatedAt: r.updated_at as string,
      }));
      return { runs, total: tokensOf(sum), more: rows.length > USAGE_PAGE };
    });
  }

  deleteBoard(scope: string, board: string): Promise<number> {
    return this.run(async (tx) => {
      const [row] = await tx<Row[]>`select agent_memory.delete_board_usage(${scope}::text, ${board}::text) as n`;
      return row.n as number;
    });
  }
}

/** Counts read as text (bigint) and returned as numbers; the write limits keep them within 2^53 − 1. */
function tokensOf(r: Row): ModelTokens {
  return {
    input: Number(r.input),
    output: Number(r.output),
    cacheRead: Number(r.cache_read),
    cacheWrite: Number(r.cache_write),
  };
}
