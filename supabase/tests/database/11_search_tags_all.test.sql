begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

-- one-hot vector at dim i, optionally with weight w at dim j
create function pg_temp.v(i int, j int default 1, w real default 0) returns extensions.vector
language sql immutable as $$
  select (array_agg(case when d = i then 1::real when d = j and w > 0 then w else 0::real end order by d))::extensions.vector
  from generate_series(1, 384) d
$$;

-- ids of a search, sorted, so results compare as sets
create function pg_temp.ids(p_query text, p_emb extensions.vector, p_mode text, p_tags text[], p_tags_all text[], p_limit int)
returns uuid[] language sql as $$
  select coalesce(array_agg(id order by id), '{}')
  from agent_memory.search_memories(p_query, p_emb, p_mode, null, null, p_tags, p_tags_all, null, null, p_limit)
$$;

insert into agent_memory.scopes (id, name) values
  ('a0000000-0000-0000-0000-00000000000a', 'alpha'),
  ('b0000000-0000-0000-0000-00000000000b', 'beta');
insert into agent_memory.members (id, display_name, kind) values
  ('11111111-1111-1111-1111-111111111111', 'rw', 'human'),
  ('44444444-4444-4444-4444-444444444444', 'bw', 'bot');
insert into agent_memory.scope_grants (scope_id, member_id, access) values
  ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'write'),
  ('b0000000-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', 'write');

insert into agent_memory.memories (id, scope_id, content, category, tags, created_by, updated_by, embedding) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'heat pump note one', 'other',
   '{repo:x,status:open,owner:me}', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', pg_temp.v(5)),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'heat pump note two', 'other',
   '{repo:x,status:done,owner:me}', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', pg_temp.v(6)),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-00000000000a', 'heat pump note three', 'other',
   '{repo:x,status:open}', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', pg_temp.v(7)),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-00000000000a', 'heat pump note four', 'other',
   '{}', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', pg_temp.v(8)),
  ('bbbbbbbb-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-00000000000b', 'heat pump beta secret', 'other',
   '{status:open,owner:me}', '44444444-4444-4444-4444-444444444444', '44444444-4444-4444-4444-444444444444', pg_temp.v(1));

-- 20 readable rows that match status:open only, all nearer to the query vector v(1), and ranking higher for the keyword
-- query 'heat pump', than any row above
insert into agent_memory.memories (scope_id, content, category, tags, created_by, updated_by, embedding)
select 'a0000000-0000-0000-0000-00000000000a', 'heat pump heat pump heat pump filler ' || i, 'other', '{status:open}',
       '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', pg_temp.v(1, 100 + i, 0.1)
from generate_series(1, 20) i;
analyze agent_memory.memories;

select ok(has_function_privilege('agent_memory_member',
  'agent_memory.search_memories(text, extensions.vector, text, uuid[], text, text[], text[], timestamptz, timestamptz, int)', 'execute'),
  'member can execute the 10-argument search_memories');
select ok(not has_function_privilege('anon',
  'agent_memory.search_memories(text, extensions.vector, text, uuid[], text, text[], text[], timestamptz, timestamptz, int)', 'execute'),
  'anon cannot execute the 10-argument search_memories');
select ok(not has_function_privilege('authenticated',
  'agent_memory.search_memories(text, extensions.vector, text, uuid[], text, text[], text[], timestamptz, timestamptz, int)', 'execute'),
  'authenticated cannot execute the 10-argument search_memories');

select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;

select is(pg_temp.ids('x', pg_temp.v(1), 'semantic', null, '{status:open,owner:me}', 50),
  array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[], 'semantic: tags_all requires every tag');
select is(pg_temp.ids('heat pump', null, 'keyword', null, '{status:open,owner:me}', 50),
  array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[], 'keyword: tags_all requires every tag');
select is(pg_temp.ids('heat pump', pg_temp.v(1), 'hybrid', null, '{status:open,owner:me}', 50),
  array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[], 'hybrid: tags_all requires every tag');
select is(pg_temp.ids('zzzz', pg_temp.v(1), 'hybrid', null, '{status:open,owner:me}', 1),
  array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[], 'hybrid tags_all filter applies before limit');
select is(pg_temp.ids('heat pump', null, 'keyword', null, '{status:open,owner:me}', 1),
  array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[], 'keyword tags_all filter applies before limit');
select is(pg_temp.ids('heat pump', pg_temp.v(1), 'hybrid', null, '{status:open,owner:me}', 1),
  array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[], 'hybrid (both arms matching) tags_all filter applies before limit');
select is(pg_temp.ids('x', pg_temp.v(1), 'semantic', null, '{status:open,owner:me}', 1),
  array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[], 'semantic tags_all filter applies before limit');
select is(pg_temp.ids('x', pg_temp.v(1), 'semantic', '{status:open,status:done}', '{owner:me}', 50),
  array['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002']::uuid[],
  'tags (any) and tags_all (every) combine');
select is(pg_temp.ids('x', pg_temp.v(1), 'semantic', null, '{owner:nobody}', 50), '{}'::uuid[],
  'tags_all with a tag no memory has returns nothing');
select ok(not ('bbbbbbbb-0000-0000-0000-000000000005' = any (pg_temp.ids('x', pg_temp.v(1), 'semantic', null, '{owner:me}', 50))),
  'tags_all does not reach an unreadable scope');
select is(pg_temp.ids('x', pg_temp.v(1), 'semantic', null, '{}', 50), pg_temp.ids('x', pg_temp.v(1), 'semantic', null, null, 50),
  'an empty tags_all is no filter');
select is((select coalesce(array_agg(id order by id), '{}') from agent_memory.search_memories('heat pump', pg_temp.v(1), 'hybrid', null, null, '{owner:me}', null, null, 50)),
  pg_temp.ids('heat pump', pg_temp.v(1), 'hybrid', '{owner:me}', null, 50),
  'the 9-argument search_memories still works and matches tags_all null');

reset role;
select * from finish();
rollback;
