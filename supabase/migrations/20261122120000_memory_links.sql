-- Typed, directional links between memories (design: docs/superpowers/specs/2026-11-22-memory-links-design.md).
--
-- A link is visible only to a member who can read BOTH ends, and only while neither end is soft-deleted, so a link can
-- never reveal that an unreadable memory exists. Members get select only; every write goes through a function.

-- ===== 1. Table, policy, grants =====

create table agent_memory.memory_links (
  from_id uuid not null references agent_memory.memories (id) on delete cascade,
  to_id uuid not null references agent_memory.memories (id) on delete cascade,
  type text not null check (type in ('relates-to', 'supersedes', 'derived-from', 'depends-on')),
  created_by uuid not null references agent_memory.members (id),
  created_at timestamptz not null default now(),
  primary key (from_id, to_id, type),
  check (from_id <> to_id)
);
create index memory_links_to_idx on agent_memory.memory_links (to_id, type);
-- relates-to has no direction, so a pair is one row whichever way round it was given.
create unique index memory_links_relates_pair on agent_memory.memory_links
  (least(from_id, to_id), greatest(from_id, to_id)) where type = 'relates-to';

alter table agent_memory.memory_links enable row level security;

-- The subqueries run under the memories policy, so each one is true only for a readable, undeleted memory.
create policy memory_links_select on agent_memory.memory_links for select to agent_memory_member
  using (exists (select 1 from agent_memory.memories m where m.id = from_id)
    and exists (select 1 from agent_memory.memories m where m.id = to_id));

grant select on agent_memory.memory_links to agent_memory_member;

-- ===== 2. Write functions =====

-- Who may create a link: supersedes needs write on BOTH scopes; relates-to needs write on EITHER; derived-from and
-- depends-on need write on the from scope. All need read on both memories, and "not found" reads the same for an
-- absent id and an unreadable one. A memory has at most 100 outgoing links (mirrors MEMORY_LINKS_OUT_MAX in
-- supabase/functions/_shared/limits.ts); incoming links are not capped.
create function agent_memory.relate_memories(p_from uuid, p_to uuid, p_type text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_from_scope uuid;
  v_to_scope uuid;
  v_name text;
  v_n int;
  v_swap uuid;
begin
  if p_type is null or p_type not in ('relates-to', 'supersedes', 'derived-from', 'depends-on') then
    raise exception 'Invalid link type ''%''', p_type;
  end if;
  if p_from is not distinct from p_to then
    raise exception 'A memory cannot be linked to itself';
  end if;
  perform agent_memory.require_memory_readable(p_from);
  perform agent_memory.require_memory_readable(p_to);
  select m.scope_id into v_from_scope from agent_memory.memories m where m.id = p_from;
  select m.scope_id into v_to_scope from agent_memory.memories m where m.id = p_to;

  if p_type = 'supersedes' then
    if not agent_memory.can_write(v_from_scope) then
      select s.name into v_name from agent_memory.scopes s where s.id = v_from_scope;
      raise exception 'No write access to scope ''%''', v_name;
    end if;
    if not agent_memory.can_write(v_to_scope) then
      select s.name into v_name from agent_memory.scopes s where s.id = v_to_scope;
      raise exception 'No write access to scope ''%''', v_name;
    end if;
  elsif p_type = 'relates-to' then
    if not (agent_memory.can_write(v_from_scope) or agent_memory.can_write(v_to_scope)) then
      select s.name into v_name from agent_memory.scopes s where s.id = v_from_scope;
      raise exception 'No write access to scope ''%''', v_name;
    end if;
  else
    if not agent_memory.can_write(v_from_scope) then
      select s.name into v_name from agent_memory.scopes s where s.id = v_from_scope;
      raise exception 'No write access to scope ''%''', v_name;
    end if;
  end if;

  -- relates-to has no direction, so store it from an end the caller can write. Otherwise anyone who can only read the
  -- from memory's scope could fill that memory's outgoing cap and block its owners.
  if p_type = 'relates-to' and not agent_memory.can_write(v_from_scope) then
    v_swap := p_from;
    p_from := p_to;
    p_to := v_swap;
    v_swap := v_from_scope;
    v_from_scope := v_to_scope;
    v_to_scope := v_swap;
  end if;

  -- Repeating a link that already exists (the reversed relates-to pair included) is a silent no-op, even at the cap.
  if exists (
    select 1 from agent_memory.memory_links l
    where l.type = p_type
      and ((l.from_id = p_from and l.to_id = p_to)
        or (p_type = 'relates-to' and l.from_id = p_to and l.to_id = p_from))
  ) then
    return;
  end if;

  select pg_catalog.count(*) into v_n from agent_memory.memory_links l where l.from_id = p_from;
  if v_n >= 100 then
    raise exception 'Memory % already has 100 outgoing links', p_from;
  end if;

  insert into agent_memory.memory_links (from_id, to_id, type, created_by)
  values (p_from, p_to, p_type, agent_memory.current_member_id())
  on conflict do nothing;
end
$$;

-- Removal needs write on EITHER end's scope, so whoever owns a memory can always remove a link pointing at it.
-- Returns true when a link was removed. For relates-to the order of the two ids does not matter.
create function agent_memory.unrelate_memories(p_from uuid, p_to uuid, p_type text) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_from_scope uuid;
  v_to_scope uuid;
  v_name text;
  v_n int;
begin
  if p_type is null or p_type not in ('relates-to', 'supersedes', 'derived-from', 'depends-on') then
    raise exception 'Invalid link type ''%''', p_type;
  end if;
  perform agent_memory.require_memory_readable(p_from);
  perform agent_memory.require_memory_readable(p_to);
  select m.scope_id into v_from_scope from agent_memory.memories m where m.id = p_from;
  select m.scope_id into v_to_scope from agent_memory.memories m where m.id = p_to;
  if not (agent_memory.can_write(v_from_scope) or agent_memory.can_write(v_to_scope)) then
    select s.name into v_name from agent_memory.scopes s where s.id = v_from_scope;
    raise exception 'No write access to scope ''%''', v_name;
  end if;

  delete from agent_memory.memory_links l
  where l.type = p_type
    and ((l.from_id = p_from and l.to_id = p_to)
      or (p_type = 'relates-to' and l.from_id = p_to and l.to_id = p_from));
  get diagnostics v_n = row_count;
  return v_n > 0;
end
$$;

revoke execute on function agent_memory.relate_memories(uuid, uuid, text) from public;
revoke execute on function agent_memory.unrelate_memories(uuid, uuid, text) from public;
grant execute on function agent_memory.relate_memories(uuid, uuid, text) to agent_memory_member;
grant execute on function agent_memory.unrelate_memories(uuid, uuid, text) to agent_memory_member;

-- ===== 3. Read functions (security invoker: row-level security decides what is visible) =====

-- Breadth-first walk from p_id over visible links. p_direction is 'out', 'in' or 'both'; relates-to has no direction
-- and matches every filter, always reading as 'both'. p_types null means every type. The walk goes at most
-- least(p_depth, 3) hops and only through memories in p_scope_ids (null means any); the start memory is always
-- allowed and never returned. Each memory comes back once, at its shallowest depth, with the path of steps that reached
-- it. Rows are ordered by depth, then the reaching link's created_at (newest first), then id, at most p_limit.
create function agent_memory.memory_neighbours(
  p_id uuid, p_direction text, p_types text[], p_depth int, p_scope_ids uuid[], p_limit int
) returns table (id uuid, depth int, path jsonb)
language sql stable security invoker
set search_path = ''
as $$
  with recursive walk as (
    select p_id as id, 0 as depth, '[]'::jsonb as path, array[p_id] as seen, null::timestamptz as via_at
    union all
    select e.other, w.depth + 1,
           w.path || pg_catalog.jsonb_build_array(
             pg_catalog.jsonb_build_object('type', e.type, 'direction', e.dir, 'memoryId', e.other)),
           w.seen || e.other, e.created_at
    from walk w
    cross join lateral (
      select l.created_at, l.type,
             case when l.type = 'relates-to' then 'both' when l.from_id = w.id then 'out' else 'in' end as dir,
             case when l.from_id = w.id then l.to_id else l.from_id end as other
      from agent_memory.memory_links l
      where (l.from_id = w.id or l.to_id = w.id)
        and (p_types is null or l.type = any (p_types))
        and (p_direction = 'both' or l.type = 'relates-to'
             or (p_direction = 'out' and l.from_id = w.id) or (p_direction = 'in' and l.to_id = w.id))
    ) e
    join agent_memory.memories m on m.id = e.other
    where w.depth < least(p_depth, 3)
      and not (e.other = any (w.seen))
      and (p_scope_ids is null or m.scope_id = any (p_scope_ids))
  ),
  shallowest as (
    select distinct on (walk.id) walk.id, walk.depth, walk.path, walk.via_at
    from walk where walk.depth > 0
    order by walk.id, walk.depth, walk.via_at desc
  )
  select s.id, s.depth, s.path from shallowest s
  order by s.depth, s.via_at desc, s.id
  limit p_limit
$$;

-- Every visible link end for each id in p_ids, one row per end. direction is 'out' where the id is from_id, 'in' where it
-- is to_id, and 'both' for every relates-to link.
create function agent_memory.memory_links_for(p_ids uuid[])
returns table (memory_id uuid, type text, direction text, other_id uuid, created_at timestamptz)
language sql stable security invoker
set search_path = ''
as $$
  select l.from_id, l.type, case when l.type = 'relates-to' then 'both' else 'out' end, l.to_id, l.created_at
  from agent_memory.memory_links l where l.from_id = any (p_ids)
  union all
  select l.to_id, l.type, case when l.type = 'relates-to' then 'both' else 'in' end, l.from_id, l.created_at
  from agent_memory.memory_links l where l.to_id = any (p_ids)
$$;

revoke execute on function agent_memory.memory_neighbours(uuid, text, text[], int, uuid[], int) from public;
revoke execute on function agent_memory.memory_links_for(uuid[]) from public;
grant execute on function agent_memory.memory_neighbours(uuid, text, text[], int, uuid[], int) to agent_memory_member;
grant execute on function agent_memory.memory_links_for(uuid[]) to agent_memory_member;
