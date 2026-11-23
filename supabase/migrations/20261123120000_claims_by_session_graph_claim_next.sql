-- Claims held by member and session, and claim_next
-- (design: docs/superpowers/specs/2026-11-23-claims-by-session-graph-claim-next-design.md).
--
-- A claim's holder is now the pair (member, session), where a null session equals only a null session. The same member
-- from another session is refused like any other holder unless force is passed. The graph tool needs no SQL: it runs
-- ordinary queries as the member under row-level security.

-- ===== 1. Claims held by member and session =====

drop function agent_memory.claim_memory(uuid, text, int, boolean, boolean, uuid);
drop function agent_memory.release_claim(uuid, boolean);

-- The refusal text for an active claim the caller does not hold. Another member is named; the caller's own other
-- session is shown (sessions are shown only to their member) by label, or by id when it has none.
create function agent_memory.claim_held_message(p_claim agent_memory.memory_claims, p_me uuid) returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_who text;
  v_label text;
begin
  if p_claim.member_id <> p_me then
    v_who := 'claimed by ' || agent_memory.member_name(p_claim.member_id);
  elsif p_claim.session_id is null then
    v_who := 'claimed by you without a session';
  else
    select s.label into v_label from agent_memory.agent_sessions s where s.id = p_claim.session_id;
    v_who := 'claimed by your session ''' || coalesce(v_label, p_claim.session_id::text) || '''';
  end if;
  if p_claim.expires_at is null then
    return pg_catalog.format('Memory %s is %s indefinitely: %s', p_claim.memory_id, v_who, p_claim.description);
  end if;
  return pg_catalog.format('Memory %s is %s until %s: %s', p_claim.memory_id, v_who,
    pg_catalog.to_char(p_claim.expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), p_claim.description);
end
$$;

-- Claim a memory for p_minutes, or indefinitely. Needs read on the memory and write on its scope. A claim held by the
-- same member and the same session (null equals null) is renewed; any other active claim fails unless p_force, which
-- takes it over and reports it (with its session when it was the caller's own member's).
create function agent_memory.claim_memory(
  p_memory uuid, p_description text, p_minutes int, p_indefinite boolean, p_force boolean, p_session uuid
) returns table (
  expires_at timestamptz, overridden_by text, overridden_until timestamptz, overridden_description text,
  overridden_indefinite boolean, overridden_session_id uuid, overridden_session_label text
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
  v_held boolean := false;
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
  -- v_held: an active claim by someone other than this member and session.
  if found then
    v_held := (v_old.expires_at is null or v_old.expires_at > pg_catalog.now())
      and agent_memory.claim_holder_active(v_old.member_id)
      and not (v_old.member_id = v_me and v_old.session_id is not distinct from p_session);
  end if;

  if v_held and not coalesce(p_force, false) then
    raise exception '%', agent_memory.claim_held_message(v_old, v_me);
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
    case when v_held then agent_memory.member_name(v_old.member_id) end,
    case when v_held then v_old.expires_at end,
    case when v_held then v_old.description end,
    case when v_held then v_old.expires_at is null end,
    case when v_held and v_old.member_id = v_me then v_old.session_id end,
    case when v_held and v_old.member_id = v_me
         then (select s.label from agent_memory.agent_sessions s where s.id = v_old.session_id) end;
end
$$;

-- Release a claim. Needs read on the memory and write on its scope. The holding member and session (null equals null)
-- release their own; any other active claim needs p_force. Returns true when an active claim was released; an inactive
-- leftover row is removed and false is returned.
create function agent_memory.release_claim(p_memory uuid, p_force boolean, p_session uuid) returns boolean
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
  if p_session is not null and not agent_memory.owns_session(p_session) then
    raise exception 'Session not found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('claim:' || p_memory::text, 0));

  select c.* into v_old from agent_memory.memory_claims c where c.memory_id = p_memory;
  if not found then
    return false;
  end if;
  v_active := (v_old.expires_at is null or v_old.expires_at > pg_catalog.now())
    and agent_memory.claim_holder_active(v_old.member_id);
  if v_active and not (v_old.member_id = v_me and v_old.session_id is not distinct from p_session)
     and not coalesce(p_force, false) then
    -- Your own other session: point at it, since the usual cause is a release that forgot its session.
    if v_old.member_id = v_me then
      raise exception '%; release it from that session, or pass force to release it anyway',
        agent_memory.claim_held_message(v_old, v_me);
    end if;
    raise exception '%; pass force to release it', agent_memory.claim_held_message(v_old, v_me);
  end if;
  delete from agent_memory.memory_claims c where c.memory_id = p_memory;
  return v_active;
end
$$;

revoke execute on function agent_memory.claim_held_message(agent_memory.memory_claims, uuid) from public;
revoke execute on function agent_memory.claim_memory(uuid, text, int, boolean, boolean, uuid) from public;
revoke execute on function agent_memory.release_claim(uuid, boolean, uuid) from public;
grant execute on function agent_memory.claim_memory(uuid, text, int, boolean, boolean, uuid) to agent_memory_member;
grant execute on function agent_memory.release_claim(uuid, boolean, uuid) to agent_memory_member;

-- ===== 2. claim_next =====

-- Claim the oldest memory matching the filters that nobody actively claims, that the caller can read and write, that
-- is not soft-deleted and that no readable, undeleted memory supersedes. p_scope_ids null means every scope. Needs
-- p_tags (any) or p_tags_all (all). A candidate whose claim lock another transaction holds is skipped, never waited on,
-- so two callers get different memories. Returns one row (the memory and the new end, null when indefinite) or none.
create function agent_memory.claim_next(
  p_scope_ids uuid[], p_category text, p_tags text[], p_tags_all text[], p_description text, p_minutes int,
  p_indefinite boolean, p_session uuid
) returns table (memory_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_desc text := pg_catalog.btrim(coalesce(p_description, ''));
  v_me uuid := agent_memory.current_member_id();
  v_id uuid;
  v_old agent_memory.memory_claims;
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
  if coalesce(pg_catalog.cardinality(p_tags), 0) = 0 and coalesce(pg_catalog.cardinality(p_tags_all), 0) = 0 then
    raise exception 'Pass tags or tags_all';
  end if;
  if p_session is not null and not agent_memory.owns_session(p_session) then
    raise exception 'Session not found';
  end if;

  for v_id in
    select m.id from agent_memory.memories m
    where m.deleted_at is null
      and (p_scope_ids is null or m.scope_id = any (p_scope_ids))
      and agent_memory.can_read(m.scope_id) and agent_memory.can_write(m.scope_id)
      and (p_category is null or m.category = p_category)
      and (coalesce(pg_catalog.cardinality(p_tags), 0) = 0 or m.tags operator(pg_catalog.&&) p_tags)
      and (coalesce(pg_catalog.cardinality(p_tags_all), 0) = 0 or m.tags operator(pg_catalog.@>) p_tags_all)
      and not exists (
        select 1 from agent_memory.memory_claims c
        where c.memory_id = m.id and (c.expires_at is null or c.expires_at > pg_catalog.now())
          and agent_memory.claim_holder_active(c.member_id))
      and not exists (
        select 1 from agent_memory.memory_links l join agent_memory.memories f on f.id = l.from_id
        where l.to_id = m.id and l.type = 'supersedes' and f.deleted_at is null and agent_memory.can_read(f.scope_id))
    order by m.created_at, m.id
  loop
    -- Another caller is claiming this one right now: skip it rather than wait.
    if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('claim:' || v_id::text, 0)) then
      continue;
    end if;
    -- Re-check under the lock: a claim committed since the candidate scan wins.
    select c.* into v_old from agent_memory.memory_claims c where c.memory_id = v_id;
    if found and (v_old.expires_at is null or v_old.expires_at > pg_catalog.now())
       and agent_memory.claim_holder_active(v_old.member_id) then
      continue;
    end if;
    v_until := case when coalesce(p_indefinite, false) then null
                    else pg_catalog.now() + pg_catalog.make_interval(mins => p_minutes) end;
    insert into agent_memory.memory_claims (memory_id, member_id, session_id, description, claimed_at, expires_at)
    values (v_id, v_me, p_session, v_desc, pg_catalog.now(), v_until)
    on conflict (memory_id) do update
      set member_id = excluded.member_id, session_id = excluded.session_id, description = excluded.description,
          claimed_at = excluded.claimed_at, expires_at = excluded.expires_at;
    return query select v_id, v_until;
    return;
  end loop;
end
$$;

revoke execute on function agent_memory.claim_next(uuid[], text, text[], text[], text, int, boolean, uuid) from public;
grant execute on function agent_memory.claim_next(uuid[], text, text[], text[], text, int, boolean, uuid) to agent_memory_member;
