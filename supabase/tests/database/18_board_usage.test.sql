begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

-- Fixtures (as postgres). w writes s1; r reads s1; o has no grants. s2 is a second scope w writes.
-- Memories in s1: i1 an intent of board b1, f1 a fact of b1, i2 an intent of board b2.
insert into agent_memory.scopes (id, name) values ('a1000000-0000-0000-0000-0000000000a1', 's1'), ('a2000000-0000-0000-0000-0000000000a2', 's2');
insert into agent_memory.members (id, display_name, kind) values
  ('11111111-1111-1111-1111-111111111111', 'w', 'human'), ('44444444-4444-4444-4444-444444444444', 'r', 'human'), ('55555555-5555-5555-5555-555555555555', 'o', 'human');
insert into agent_memory.scope_grants (scope_id, member_id, access) values
  ('a1000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'write'),
  ('a2000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'write'),
  ('a1000000-0000-0000-0000-0000000000a1', '44444444-4444-4444-4444-444444444444', 'read');
insert into agent_memory.memories (id, scope_id, content, category, tags, created_by, updated_by, embedding) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-0000000000a1', 'i1', 'observation', array['board:b1', 'kind:intent'],
   '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', array_fill(0.1::real, array[384])::extensions.vector),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-0000000000a1', 'f1', 'observation', array['board:b1', 'kind:fact'],
   '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', array_fill(0.1::real, array[384])::extensions.vector),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-0000000000a1', 'i2', 'observation', array['board:b2', 'kind:intent'],
   '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', array_fill(0.1::real, array[384])::extensions.vector);

-- A call with every argument; only the varied ones change per test.
create function pg_temp.rec(
  p_scope text default 's1', p_board text default 'b1', p_label text default 'board-b1-0001', p_role text default 'worker',
  p_intent text default null, p_input bigint default 10, p_models jsonb default '{"opus": {"input": 10, "output": 2, "cacheRead": 0, "cacheWrite": 0}}'
) returns uuid language sql as $$
  select agent_memory.record_board_usage(p_scope, p_board, p_label, p_role, p_intent, 'fact confirmed', 'opus',
    p_input, 2, 100, 5, 3, 1234, p_models, '2026-11-27T08:00:00Z', '2026-11-27T08:05:00Z')
$$;
grant execute on function pg_temp.rec(text, text, text, text, text, bigint, jsonb) to agent_memory_member;

select has_table('agent_memory', 'board_usage', 'board_usage exists');
select policies_are('agent_memory', 'board_usage', array['board_usage_select'], 'only a select policy');
select ok(not has_function_privilege('anon', 'agent_memory.record_board_usage(text, text, text, text, text, text, text, bigint, bigint, bigint, bigint, int, bigint, jsonb, text, text)', 'execute'),
  'anon cannot execute record_board_usage');
select ok(not has_function_privilege('anon', 'agent_memory.delete_board_usage(text, text)', 'execute'), 'anon cannot execute delete_board_usage');
select ok((select 'search_path=""' = any(proconfig) from pg_proc where proname = 'record_board_usage'), 'record_board_usage pins search_path');
select ok((select 'search_path=""' = any(proconfig) from pg_proc where proname = 'delete_board_usage'), 'delete_board_usage pins search_path');

-- A writer records and reads back; the same key upserts.
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select throws_ok($$insert into agent_memory.board_usage (scope_id, board, run_label, role, runner_model) values ('a1000000-0000-0000-0000-0000000000a1', 'b1', 'x', 'worker', 'opus')$$,
  '42501', null, 'members cannot insert directly');
select isnt(pg_temp.rec(p_intent => 'aaaaaaaa-0000-0000-0000-000000000001'), null, 'w records a worker run');
select is((select row(input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, turns, duration_ms, outcome, runner_model)::text
  from agent_memory.board_usage where run_label = 'board-b1-0001'), '(10,2,100,5,3,1234,"fact confirmed",opus)', 'the counts are stored');
select is((select intent_id from agent_memory.board_usage where run_label = 'board-b1-0001'), 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'a real intent of the board is kept');
select is((select recorded_by from agent_memory.board_usage where run_label = 'board-b1-0001'), '11111111-1111-1111-1111-111111111111'::uuid, 'recorded_by is the caller');
select is((select ended_at from agent_memory.board_usage where run_label = 'board-b1-0001'), '2026-11-27T08:05:00Z'::timestamptz, 'ended_at is stored');
select lives_ok($$select pg_temp.rec(p_input => 99)$$, 'recording the same key again works');
select is((select count(*)::int from agent_memory.board_usage where run_label = 'board-b1-0001'), 1, 'the same key stays one row');
select is((select input_tokens from agent_memory.board_usage where run_label = 'board-b1-0001'), 99::bigint, 'the row holds the new totals');

-- The intent id is kept only when it names an intent of that board.
select pg_temp.rec(p_label => 'board-b1-0002', p_intent => 'not-a-uuid');
select pg_temp.rec(p_label => 'board-b1-0003', p_intent => 'aaaaaaaa-0000-0000-0000-000000000002');
select pg_temp.rec(p_label => 'board-b1-0004', p_intent => 'aaaaaaaa-0000-0000-0000-000000000003');
select is((select count(*)::int from agent_memory.board_usage where run_label in ('board-b1-0002', 'board-b1-0003', 'board-b1-0004') and intent_id is null), 3,
  'a non-uuid, a fact and another board''s intent are all stored as null');

-- Validation
select throws_ok($$select pg_temp.rec(p_input => -1)$$, 'P0001', 'Token counts must be whole numbers from 0', 'a negative count is refused');
select throws_ok($$select pg_temp.rec(p_role => 'boss')$$, 'P0001', 'Role must be worker, lead, start or release', 'an unknown role is refused');
select throws_ok(format($f$select pg_temp.rec(p_label => %L)$f$, repeat('x', 101)), 'P0001', 'Run label must be 1-100 characters', 'a 101-character label is refused');
select throws_ok(format($f$select pg_temp.rec(p_models => %L::jsonb)$f$,
  (select jsonb_object_agg('m' || n, '{"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0}'::jsonb) from generate_series(1, 21) n)),
  'P0001', 'At most 20 models', '21 models are refused');
select throws_ok($$select pg_temp.rec(p_models => '{"opus": {"input": -3, "output": 1, "cacheRead": 0, "cacheWrite": 0}}')$$,
  'P0001', 'Token counts must be whole numbers from 0', 'a negative model count is refused');
reset role;

-- A reader reads but cannot write; a member with no grant sees nothing and gets "not found".
select set_config('agent_memory.member_id', '44444444-4444-4444-4444-444444444444', true);
set local role agent_memory_member;
select is((select count(*)::int from agent_memory.board_usage), 4, 'a reader sees the scope''s rows');
select throws_ok($$select pg_temp.rec()$$, 'P0001', 'No write access to scope ''s1''', 'a reader cannot record');
select throws_ok($$select agent_memory.delete_board_usage('s1', 'b1')$$, 'P0001', 'No write access to scope ''s1''', 'a reader cannot delete');
reset role;
select set_config('agent_memory.member_id', '55555555-5555-5555-5555-555555555555', true);
set local role agent_memory_member;
select is((select count(*)::int from agent_memory.board_usage), 0, 'a member with no grant sees no rows');
select throws_ok($$select pg_temp.rec()$$, 'P0001', 'Scope ''s1'' not found', 'an unreadable scope reads as not found');
select throws_ok($$select pg_temp.rec(p_scope => 'nope')$$, 'P0001', 'Scope ''nope'' not found', 'an absent scope reads the same');
reset role;

-- Delete per board, and the scope cascade.
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select pg_temp.rec(p_board => 'b2', p_label => 'board-b2-0001');
select pg_temp.rec(p_scope => 's2', p_label => 'board-b1-0009');
select is(agent_memory.delete_board_usage('s1', 'b1'), 4, 'delete returns the count of the board''s rows');
select is((select count(*)::int from agent_memory.board_usage where board = 'b2'), 1, 'other boards keep their rows');
reset role;
delete from agent_memory.scopes where name = 's2';
select is((select count(*)::int from agent_memory.board_usage where run_label = 'board-b1-0009'), 0, 'deleting a scope deletes its rows');

select * from finish();
rollback;
