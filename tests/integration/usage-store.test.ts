import { assertEquals, assertRejects } from '@std/assert';
import { connect } from '../../supabase/functions/_shared/db.ts';
import { PgUsageStore, type UsageRow } from '../../supabase/functions/_shared/usage-store.ts';
import { adminSql, LOCAL_DB_URL, makeWorld, type World } from '../helpers/fixtures.ts';

async function withWorld(fn: (w: World, mk: (memberId: string) => PgUsageStore) => Promise<void>) {
  const admin = adminSql();
  const sql = connect(LOCAL_DB_URL);
  const w = await makeWorld(admin);
  try {
    await fn(w, (id) => new PgUsageStore(sql, id));
  } finally {
    await w.cleanup();
    await sql.end();
    await admin.end();
  }
}

const row = (w: World, label: string, input: number, extra: Partial<UsageRow> = {}): UsageRow => ({
  scope: w.alpha.name,
  board: 'toy-usage',
  runLabel: label,
  role: 'worker',
  intentId: null,
  outcome: 'fact confirmed',
  runnerModel: 'opus',
  tokens: { input, output: 2, cacheRead: 30, cacheWrite: 4 },
  turns: 3,
  durationMs: 1000,
  models: { 'claude-opus-5-5': { input, output: 2, cacheRead: 30, cacheWrite: 4 } },
  startedAt: '2026-11-27T08:00:00.000Z',
  endedAt: '2026-11-27T08:01:00.000Z',
  ...extra,
});

Deno.test('a writer records runs, an upsert replaces a run, and forBoard sums them', () =>
  withWorld(async (w, mk) => {
    const s = mk(w.rw.id);
    const id = await s.record(row(w, 'board-toy-usage-0001', 10));
    assertEquals(await s.record(row(w, 'board-toy-usage-0001', 11)), id);
    await s.record(row(w, 'board-toy-usage-0002', 20));
    await s.record(row(w, 'board-toy-usage-lead-0003', 30, { role: 'lead', outcome: null, turns: null }));
    await s.record({ ...row(w, 'board-other-0001', 1000), board: 'other' });
    const page = await s.forBoard(w.alpha.name, 'toy-usage');
    assertEquals(page.runs.length, 3);
    assertEquals(page.total, { input: 61, output: 6, cacheRead: 90, cacheWrite: 12 });
    assertEquals(page.more, false);
    assertEquals(page.runs[0].runLabel, 'board-toy-usage-lead-0003', 'newest first');
    const first = page.runs.find((r) => r.runLabel === 'board-toy-usage-0001')!;
    assertEquals(first.tokens.input, 11);
    assertEquals(first.models, { 'claude-opus-5-5': { input: 11, output: 2, cacheRead: 30, cacheWrite: 4 } });
    assertEquals([first.startedAt, first.endedAt], ['2026-11-27T08:00:00.000Z', '2026-11-27T08:01:00.000Z']);
    assertEquals(first.recordedBy, w.rw.id);
  }));

Deno.test('a reader reads, but only a writer records or deletes', () =>
  withWorld(async (w, mk) => {
    await mk(w.rw.id).record(row(w, 'board-toy-usage-0001', 10));
    const ro = mk(w.ro.id);
    assertEquals((await ro.forBoard(w.alpha.name, 'toy-usage')).runs.length, 1);
    await assertRejects(
      () => ro.record(row(w, 'board-toy-usage-0002', 1)),
      Error,
      `No write access to scope '${w.alpha.name}'`,
    );
    await assertRejects(
      () => ro.deleteBoard(w.alpha.name, 'toy-usage'),
      Error,
      `No write access to scope '${w.alpha.name}'`,
    );
    const none = mk(w.none.id);
    assertEquals((await none.forBoard(w.alpha.name, 'toy-usage')).runs, []);
    await assertRejects(
      () => none.record(row(w, 'board-toy-usage-0003', 1)),
      Error,
      `Scope '${w.alpha.name}' not found`,
    );
  }));

Deno.test("deleteBoard removes one board's rows and returns the count", () =>
  withWorld(async (w, mk) => {
    const s = mk(w.rw.id);
    await s.record(row(w, 'board-toy-usage-0001', 1));
    await s.record(row(w, 'board-toy-usage-0002', 1));
    await s.record({ ...row(w, 'board-other-0001', 1), board: 'other' });
    assertEquals(await s.deleteBoard(w.alpha.name, 'toy-usage'), 2);
    assertEquals((await s.forBoard(w.alpha.name, 'toy-usage')).runs, []);
    assertEquals((await s.forBoard(w.alpha.name, 'other')).runs.length, 1);
  }));
