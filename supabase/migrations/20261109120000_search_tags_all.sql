-- search_memories gains p_tags_all: a memory must carry EVERY tag in it (p_tags keeps its "at least one" meaning, and
-- both may be given). The filter applies inside each arm, before its LIMIT, like the other filters.
--
-- The new function is a 10-argument overload. The 9-argument one stays as a thin wrapper, so the Edge Function that is
-- already deployed keeps working once this migration is applied. The new Edge Function calls the 10-argument overload,
-- so apply this migration BEFORE deploying it. Neither overload has defaults, so a 9-argument call is never ambiguous.

-- Contract: returns at most p_limit rows in every mode (each hybrid arm fetches p_limit, fused result is
-- trimmed to p_limit); callers over-fetch for decay re-ranking.
-- Exact similarity on purpose: an ANN index post-filtered by RLS returns short pages and leaks result counts;
-- exact scan is milliseconds at this size.
create function agent_memory.search_memories(
  p_query text,
  p_embedding extensions.vector(384),
  p_mode text,
  p_scope_ids uuid[],
  p_category text,
  p_tags text[],
  p_tags_all text[],
  p_after timestamptz,
  p_before timestamptz,
  p_limit int
) returns table (
  id uuid, scope_id uuid, scope text, content text, category text, tags text[],
  created_at timestamptz, updated_at timestamptz, created_by text, updated_by text,
  access_count int, last_accessed_at timestamptz, raw_score float8
)
language plpgsql stable security invoker
set search_path = ''
set client_min_messages = warning -- websearch_to_tsquery NOTICEs on stop-word-only queries
as $$
#variable_conflict use_column
declare
  v_tsq tsquery;
begin
  if p_mode is null or p_mode not in ('keyword', 'semantic', 'hybrid') then
    raise exception 'invalid search mode: %', p_mode using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'invalid limit: %', p_limit using errcode = '22023';
  end if;
  if p_mode <> 'keyword' and p_embedding is null then
    raise exception 'embedding required for % search', p_mode using errcode = '22023';
  end if;
  v_tsq := pg_catalog.websearch_to_tsquery('english', coalesce(p_query, ''));

  if p_mode = 'keyword' then
    if pg_catalog.numnode(v_tsq) = 0 then
      return;
    end if;
    return query
    select v.id, v.scope_id, v.scope, v.content, v.category, v.tags, v.created_at, v.updated_at,
           v.created_by, v.updated_by, v.access_count, v.last_accessed_at, k.score
    from (
      select m.id, pg_catalog.ts_rank_cd(m.fts, v_tsq)::float8 as score
      from agent_memory.memories m
      where m.fts operator(pg_catalog.@@) v_tsq
        and (p_scope_ids is null or m.scope_id = any (p_scope_ids))
        and (p_category is null or m.category = p_category)
        and (p_tags is null or m.tags && p_tags)
        and (p_tags_all is null or m.tags @> p_tags_all)
        and (p_after is null or m.created_at >= p_after)
        and (p_before is null or m.created_at <= p_before)
      order by score desc, m.id
      limit p_limit
    ) k
    join agent_memory.memory_view v on v.id = k.id
    order by k.score desc, v.id;

  elsif p_mode = 'semantic' then
    return query
    select v.id, v.scope_id, v.scope, v.content, v.category, v.tags, v.created_at, v.updated_at,
           v.created_by, v.updated_by, v.access_count, v.last_accessed_at, (1 / (1 + s.dist))::float8
    from (
      select m.id, (m.embedding operator(extensions.<=>) p_embedding) as dist
      from agent_memory.memories m
      where (p_scope_ids is null or m.scope_id = any (p_scope_ids))
        and (p_category is null or m.category = p_category)
        and (p_tags is null or m.tags && p_tags)
        and (p_tags_all is null or m.tags @> p_tags_all)
        and (p_after is null or m.created_at >= p_after)
        and (p_before is null or m.created_at <= p_before)
      order by m.embedding operator(extensions.<=>) p_embedding, m.id
      limit p_limit
    ) s
    join agent_memory.memory_view v on v.id = s.id
    order by s.dist, v.id;

  else
    return query
    with kw as (
      select m.id, pg_catalog.row_number() over (order by pg_catalog.ts_rank_cd(m.fts, v_tsq) desc, m.id) as rnk
      from agent_memory.memories m
      where pg_catalog.numnode(v_tsq) > 0 and m.fts operator(pg_catalog.@@) v_tsq
        and (p_scope_ids is null or m.scope_id = any (p_scope_ids))
        and (p_category is null or m.category = p_category)
        and (p_tags is null or m.tags && p_tags)
        and (p_tags_all is null or m.tags @> p_tags_all)
        and (p_after is null or m.created_at >= p_after)
        and (p_before is null or m.created_at <= p_before)
      order by pg_catalog.ts_rank_cd(m.fts, v_tsq) desc, m.id
      limit p_limit
    ),
    sem as (
      select m.id, pg_catalog.row_number() over (order by m.embedding operator(extensions.<=>) p_embedding, m.id) as rnk
      from agent_memory.memories m
      where (p_scope_ids is null or m.scope_id = any (p_scope_ids))
        and (p_category is null or m.category = p_category)
        and (p_tags is null or m.tags && p_tags)
        and (p_tags_all is null or m.tags @> p_tags_all)
        and (p_after is null or m.created_at >= p_after)
        and (p_before is null or m.created_at <= p_before)
      order by m.embedding operator(extensions.<=>) p_embedding, m.id
      limit p_limit
    ),
    fused as (
      select coalesce(kw.id, sem.id) as id,
             (coalesce(1.0 / (60 + kw.rnk), 0) + coalesce(1.0 / (60 + sem.rnk), 0))::float8 as score
      from kw full outer join sem on kw.id = sem.id
    )
    select v.id, v.scope_id, v.scope, v.content, v.category, v.tags, v.created_at, v.updated_at,
           v.created_by, v.updated_by, v.access_count, v.last_accessed_at, f.score
    from fused f
    join agent_memory.memory_view v on v.id = f.id
    order by f.score desc, v.id
    limit p_limit;
  end if;
end
$$;

create or replace function agent_memory.search_memories(
  p_query text,
  p_embedding extensions.vector(384),
  p_mode text,
  p_scope_ids uuid[],
  p_category text,
  p_tags text[],
  p_after timestamptz,
  p_before timestamptz,
  p_limit int
) returns table (
  id uuid, scope_id uuid, scope text, content text, category text, tags text[],
  created_at timestamptz, updated_at timestamptz, created_by text, updated_by text,
  access_count int, last_accessed_at timestamptz, raw_score float8
)
language sql stable security invoker
set search_path = ''
as $$
  select * from agent_memory.search_memories(p_query, p_embedding, p_mode, p_scope_ids, p_category, p_tags, null::text[],
                                              p_after, p_before, p_limit)
$$;

revoke execute on function agent_memory.search_memories(text, extensions.vector, text, uuid[], text, text[], text[], timestamptz, timestamptz, int) from public;
grant execute on function agent_memory.search_memories(text, extensions.vector, text, uuid[], text, text[], text[], timestamptz, timestamptz, int) to agent_memory_member;
