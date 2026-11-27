-- Token usage per board run (design: docs/superpowers/specs/2026-11-27-token-usage-design.md).
--
-- The board runner records one row per worker run, lead session or runner one-shot: raw token counts only, never
-- dollars. Members read the rows of scopes they can read; every write goes through record_board_usage, an upsert on
-- (scope, board, run label), and delete_board_usage removes a board's rows. Agents never read this table through MCP.

-- ===== 1. Table, policy, grants =====

create table agent_memory.board_usage (
  id uuid primary key default gen_random_uuid(),
  scope_id uuid not null references agent_memory.scopes (id) on delete cascade,
  board text not null check (pg_catalog.length(board) between 1 and 100),
  run_label text not null check (pg_catalog.length(run_label) between 1 and 100),
  role text not null check (role in ('worker', 'lead', 'start', 'release')),
  intent_id uuid null,
  outcome text null check (outcome is null or pg_catalog.length(outcome) <= 40),
  runner_model text not null check (pg_catalog.length(runner_model) <= 100),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cache_read_tokens bigint not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens bigint not null default 0 check (cache_write_tokens >= 0),
  turns int null check (turns is null or turns >= 0),
  duration_ms bigint null check (duration_ms is null or duration_ms >= 0),
  models jsonb not null default '{}'::jsonb,
  started_at timestamptz null,
  ended_at timestamptz null,
  recorded_by uuid not null references agent_memory.members (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scope_id, board, run_label)
);
create index board_usage_board_idx on agent_memory.board_usage (scope_id, board, updated_at desc);

alter table agent_memory.board_usage enable row level security;

create policy board_usage_select on agent_memory.board_usage for select to agent_memory_member
  using (agent_memory.can_read(scope_id));

grant select on agent_memory.board_usage to agent_memory_member;

-- ===== 2. Helpers =====

-- The id of a scope the caller may write. Absent and unreadable read the same; readable but not writable says so.
create function agent_memory.usage_scope_for_write(p_scope text) returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_scope uuid;
begin
  select s.id into v_scope from agent_memory.scopes s where s.name = p_scope;
  if v_scope is null or not agent_memory.can_read(v_scope) then
    raise exception 'Scope ''%'' not found', p_scope;
  end if;
  if not agent_memory.can_write(v_scope) then
    raise exception 'No write access to scope ''%''', p_scope;
  end if;
  return v_scope;
end
$$;

-- True when a model map is an object of at most 20 names (1-100 characters), each with four non-negative integers.
create function agent_memory.usage_models_valid(p_models jsonb) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
  v_name text;
  v_value jsonb;
  v_key text;
  v_n numeric;
begin
  if p_models is null or pg_catalog.jsonb_typeof(p_models) <> 'object' then
    raise exception 'Models must be an object';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_models)) > 20 then
    raise exception 'At most 20 models';
  end if;
  for v_name, v_value in select * from pg_catalog.jsonb_each(p_models) loop
    if pg_catalog.length(v_name) not between 1 and 100 then
      raise exception 'Model names must be 1-100 characters';
    end if;
    if pg_catalog.jsonb_typeof(v_value) <> 'object' then
      raise exception 'Each model needs input, output, cacheRead and cacheWrite';
    end if;
    foreach v_key in array array['input', 'output', 'cacheRead', 'cacheWrite'] loop
      -- Nested, because SQL does not promise to test the type before the cast.
      if pg_catalog.jsonb_typeof(v_value -> v_key) is distinct from 'number' then
        raise exception 'Token counts must be whole numbers from 0';
      end if;
      v_n := (v_value ->> v_key)::numeric;
      if v_n < 0 or v_n <> pg_catalog.trunc(v_n) or v_n > 9007199254740991 then
        raise exception 'Token counts must be whole numbers from 0';
      end if;
    end loop;
  end loop;
  return true;
end
$$;

-- ===== 3. Write functions =====

-- Record (or replace) one run's counts. Returns the row id. The intent id is kept only when it names an undeleted
-- intent of this board in this scope, so a model's typo in a BOARD-WORK line cannot attach a run to the wrong intent.
create function agent_memory.record_board_usage(
  p_scope text, p_board text, p_label text, p_role text, p_intent text, p_outcome text, p_runner_model text,
  p_input bigint, p_output bigint, p_cache_read bigint, p_cache_write bigint, p_turns int, p_duration_ms bigint,
  p_models jsonb, p_started text, p_ended text
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_scope uuid := agent_memory.usage_scope_for_write(p_scope);
  v_intent uuid;
  v_id uuid;
begin
  if p_board is null or pg_catalog.length(p_board) not between 1 and 100 then
    raise exception 'Board must be 1-100 characters';
  end if;
  if p_label is null or pg_catalog.length(p_label) not between 1 and 100 then
    raise exception 'Run label must be 1-100 characters';
  end if;
  if p_role is null or p_role not in ('worker', 'lead', 'start', 'release') then
    raise exception 'Role must be worker, lead, start or release';
  end if;
  if p_outcome is not null and pg_catalog.length(p_outcome) > 40 then
    raise exception 'Outcome must be at most 40 characters';
  end if;
  if p_runner_model is null or pg_catalog.length(p_runner_model) > 100 then
    raise exception 'Runner model must be at most 100 characters';
  end if;
  if coalesce(p_input, -1) < 0 or coalesce(p_output, -1) < 0 or coalesce(p_cache_read, -1) < 0
     or coalesce(p_cache_write, -1) < 0 or coalesce(p_turns, 0) < 0 or coalesce(p_duration_ms, 0) < 0 then
    raise exception 'Token counts must be whole numbers from 0';
  end if;
  perform agent_memory.usage_models_valid(p_models);

  if p_intent ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    select m.id into v_intent from agent_memory.memories m
    where m.id = p_intent::uuid and m.scope_id = v_scope and m.deleted_at is null
      and m.tags @> array['board:' || p_board, 'kind:intent'];
  end if;

  insert into agent_memory.board_usage as u (
    scope_id, board, run_label, role, intent_id, outcome, runner_model, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, turns, duration_ms, models, started_at, ended_at, recorded_by
  ) values (
    v_scope, p_board, p_label, p_role, v_intent, p_outcome, p_runner_model, p_input, p_output, p_cache_read,
    p_cache_write, p_turns, p_duration_ms, p_models, p_started::timestamptz, p_ended::timestamptz,
    agent_memory.current_member_id()
  )
  on conflict (scope_id, board, run_label) do update set
    role = excluded.role, intent_id = excluded.intent_id, outcome = excluded.outcome,
    runner_model = excluded.runner_model, input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens,
    cache_write_tokens = excluded.cache_write_tokens, turns = excluded.turns, duration_ms = excluded.duration_ms,
    models = excluded.models, started_at = excluded.started_at, ended_at = excluded.ended_at,
    recorded_by = excluded.recorded_by, updated_at = pg_catalog.now()
  returning u.id into v_id;
  return v_id;
end
$$;

-- Delete every row of a board; returns how many.
create function agent_memory.delete_board_usage(p_scope text, p_board text) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_scope uuid := agent_memory.usage_scope_for_write(p_scope);
  v_count int;
begin
  delete from agent_memory.board_usage u where u.scope_id = v_scope and u.board = p_board;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke execute on function agent_memory.usage_scope_for_write(text) from public;
revoke execute on function agent_memory.usage_models_valid(jsonb) from public;
revoke execute on function agent_memory.record_board_usage(text, text, text, text, text, text, text, bigint, bigint, bigint, bigint, int, bigint, jsonb, text, text) from public;
revoke execute on function agent_memory.delete_board_usage(text, text) from public;
grant execute on function agent_memory.record_board_usage(text, text, text, text, text, text, text, bigint, bigint, bigint, bigint, int, bigint, jsonb, text, text) to agent_memory_member;
grant execute on function agent_memory.delete_board_usage(text, text) to agent_memory_member;
