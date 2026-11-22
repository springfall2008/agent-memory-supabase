-- Claims on memories (design: docs/superpowers/specs/2026-11-22-memory-claims-design.md).
--
-- A claim is an advisory, self-expiring (or indefinite) "I'm working on this" held by a member. The session that made
-- or last renewed it is recorded for information only and shown only to the holder. A claim is active while it has not
-- expired, its memory is not soft-deleted and its holder is not deactivated; an inactive row counts as no claim.

-- ===== 1. Table, helper, policy, grants =====

create table agent_memory.memory_claims (
  memory_id uuid primary key references agent_memory.memories (id) on delete cascade,
  member_id uuid not null references agent_memory.members (id),
  session_id uuid null references agent_memory.agent_sessions (id) on delete set null,
  description text not null check (pg_catalog.length(description) between 1 and 200),
  claimed_at timestamptz not null default now(),
  expires_at timestamptz null,
  check (expires_at is null or expires_at > claimed_at)
);
create index memory_claims_member_idx on agent_memory.memory_claims (member_id, expires_at);

-- True unless the member is deactivated. Security definer because the members policy may hide the row from the caller.
create function agent_memory.claim_holder_active(p_member uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select not exists (
    select 1 from agent_memory.members m where m.id = p_member and m.deactivated_at is not null
  )
$$;

alter table agent_memory.memory_claims enable row level security;

-- The subquery runs under the memories policy, so a claim is visible exactly when its memory is readable and undeleted.
create policy memory_claims_select on agent_memory.memory_claims for select to agent_memory_member
  using (exists (select 1 from agent_memory.memories m where m.id = memory_id));

grant select on agent_memory.memory_claims to agent_memory_member;

-- ===== 2. Write functions =====

-- Claim a memory for p_minutes, or indefinitely. Needs read on the memory and write on its scope. A claim held by the
-- same member (from any session) is renewed; one held by another member fails unless p_force, which takes it over.
-- Returns exactly one row: the new end (null when indefinite), the claim that was overridden if any, and the session
-- recorded before when the same member renewed from a different session.
create function agent_memory.claim_memory(
  p_memory uuid, p_description text, p_minutes int, p_indefinite boolean, p_force boolean, p_session uuid
) returns table (
  expires_at timestamptz, overridden_by text, overridden_until timestamptz, overridden_description text,
  overridden_indefinite boolean, previous_session_id uuid, previous_session_label text
)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_desc text := pg_catalog.btrim(coalesce(p_description, ''));
  v_me uuid := agent_memory.current_member_id();
  v_scope uuid;
  v_name text;
  v_old agent_memory.memory_claims;
  v_active boolean := false;
  v_until timestamptz;
begin
  if pg_catalog.length(v_desc) not between 1 and 200 then
    raise exception 'Description must be 1-200 characters';
  end if;
  if coalesce(p_indefinite, false) and p_minutes is not null then
    raise exception 'Pass minutes or indefinite, not both';
  end if;
  if not coalesce(p_indefinite, false) and (p_minutes is null or p_minutes not between 1 and 5256000) then
    raise exception 'minutes must be between 1 and 5256000';
  end if;
  perform agent_memory.require_memory_readable(p_memory);
  select m.scope_id into v_scope from agent_memory.memories m where m.id = p_memory;
  if not agent_memory.can_write(v_scope) then
    select s.name into v_name from agent_memory.scopes s where s.id = v_scope;
    raise exception 'No write access to scope ''%''', v_name;
  end if;
  if p_session is not null and not agent_memory.owns_session(p_session) then
    raise exception 'Session not found';
  end if;

  -- Serialize claims on this memory, so two callers cannot both see it free.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('claim:' || p_memory::text, 0));

  select c.* into v_old from agent_memory.memory_claims c where c.memory_id = p_memory;
  if found then
    v_active := (v_old.expires_at is null or v_old.expires_at > pg_catalog.now())
      and agent_memory.claim_holder_active(v_old.member_id);
  end if;

  if v_active and v_old.member_id <> v_me and not coalesce(p_force, false) then
    if v_old.expires_at is null then
      raise exception 'Memory % is claimed by % indefinitely: %',
        p_memory, agent_memory.member_name(v_old.member_id), v_old.description;
    end if;
    raise exception 'Memory % is claimed by % until %: %',
      p_memory, agent_memory.member_name(v_old.member_id),
      pg_catalog.to_char(v_old.expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), v_old.description;
  end if;

  v_until := case when coalesce(p_indefinite, false) then null
                  else pg_catalog.now() + pg_catalog.make_interval(mins => p_minutes) end;
  insert into agent_memory.memory_claims (memory_id, member_id, session_id, description, claimed_at, expires_at)
  values (p_memory, v_me, p_session, v_desc, pg_catalog.now(), v_until)
  on conflict (memory_id) do update
    set member_id = excluded.member_id, session_id = excluded.session_id, description = excluded.description,
        claimed_at = excluded.claimed_at, expires_at = excluded.expires_at;

  return query select
    v_until,
    case when v_active and v_old.member_id <> v_me then agent_memory.member_name(v_old.member_id) end,
    case when v_active and v_old.member_id <> v_me then v_old.expires_at end,
    case when v_active and v_old.member_id <> v_me then v_old.description end,
    case when v_active and v_old.member_id <> v_me then v_old.expires_at is null end,
    case when v_active and v_old.member_id = v_me and v_old.session_id is distinct from p_session
         then v_old.session_id end,
    case when v_active and v_old.member_id = v_me and v_old.session_id is distinct from p_session
         then (select s.label from agent_memory.agent_sessions s where s.id = v_old.session_id) end;
end
$$;

-- Release a claim. Needs read on the memory and write on its scope. The holder releases their own; another member's
-- active claim needs p_force. Returns true when an active claim was released; an inactive leftover row is removed and
-- false is returned.
create function agent_memory.release_claim(p_memory uuid, p_force boolean) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_me uuid := agent_memory.current_member_id();
  v_scope uuid;
  v_name text;
  v_old agent_memory.memory_claims;
  v_active boolean;
begin
  perform agent_memory.require_memory_readable(p_memory);
  select m.scope_id into v_scope from agent_memory.memories m where m.id = p_memory;
  if not agent_memory.can_write(v_scope) then
    select s.name into v_name from agent_memory.scopes s where s.id = v_scope;
    raise exception 'No write access to scope ''%''', v_name;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('claim:' || p_memory::text, 0));

  select c.* into v_old from agent_memory.memory_claims c where c.memory_id = p_memory;
  if not found then
    return false;
  end if;
  v_active := (v_old.expires_at is null or v_old.expires_at > pg_catalog.now())
    and agent_memory.claim_holder_active(v_old.member_id);
  if v_active and v_old.member_id <> v_me and not coalesce(p_force, false) then
    raise exception 'Memory % is claimed by %; pass force to release another member''s claim',
      p_memory, agent_memory.member_name(v_old.member_id);
  end if;
  delete from agent_memory.memory_claims c where c.memory_id = p_memory;
  return v_active;
end
$$;

revoke execute on function agent_memory.claim_holder_active(uuid) from public;
revoke execute on function agent_memory.claim_memory(uuid, text, int, boolean, boolean, uuid) from public;
revoke execute on function agent_memory.release_claim(uuid, boolean) from public;
grant execute on function agent_memory.claim_holder_active(uuid) to agent_memory_member;
grant execute on function agent_memory.claim_memory(uuid, text, int, boolean, boolean, uuid) to agent_memory_member;
grant execute on function agent_memory.release_claim(uuid, boolean) to agent_memory_member;

-- ===== 3. Read functions (security invoker: row-level security decides what is visible) =====

-- The active claim, if any, on each visible memory in p_ids. The session is returned only to the holder.
create function agent_memory.memory_claims_for(p_ids uuid[])
returns table (
  memory_id uuid, holder text, expires_at timestamptz, description text, mine boolean, session_id uuid,
  session_label text
)
language sql stable security invoker
set search_path = ''
as $$
  select c.memory_id, agent_memory.member_name(c.member_id), c.expires_at, c.description,
         c.member_id = agent_memory.current_member_id(),
         case when c.member_id = agent_memory.current_member_id() then c.session_id end,
         case when c.member_id = agent_memory.current_member_id() then s.label end
  from agent_memory.memory_claims c
  left join agent_memory.agent_sessions s on s.id = c.session_id
  where c.memory_id = any (p_ids)
    and (c.expires_at is null or c.expires_at > pg_catalog.now())
    and agent_memory.claim_holder_active(c.member_id)
$$;

-- The caller's active claims on visible memories in p_scope_ids (null means any), soonest end first, indefinite last.
create function agent_memory.my_claims(p_scope_ids uuid[], p_limit int)
returns table (
  memory_id uuid, scope text, category text, tags text[], content text, description text, claimed_at timestamptz,
  expires_at timestamptz, session_id uuid, session_label text
)
language sql stable security invoker
set search_path = ''
as $$
  select c.memory_id, v.scope, v.category, v.tags, v.content, c.description, c.claimed_at, c.expires_at,
         c.session_id, s.label
  from agent_memory.memory_claims c
  join agent_memory.memory_view v on v.id = c.memory_id
  left join agent_memory.agent_sessions s on s.id = c.session_id
  where c.member_id = agent_memory.current_member_id()
    and (c.expires_at is null or c.expires_at > pg_catalog.now())
    and (p_scope_ids is null or v.scope_id = any (p_scope_ids))
  order by c.expires_at nulls last, c.memory_id
  limit p_limit
$$;

revoke execute on function agent_memory.memory_claims_for(uuid[]) from public;
revoke execute on function agent_memory.my_claims(uuid[], int) from public;
grant execute on function agent_memory.memory_claims_for(uuid[]) to agent_memory_member;
grant execute on function agent_memory.my_claims(uuid[], int) to agent_memory_member;
