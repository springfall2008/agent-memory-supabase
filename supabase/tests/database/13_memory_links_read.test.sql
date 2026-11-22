begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

-- Fixtures (as postgres). w writes s1+s2; r reads s1 only. m1, m2, m4 are in s1; m3, m5 are in s2.
-- Links: m1->m2 depends-on, m2->m3 depends-on, m3->m1 derived-from (a cycle), m3-m4 relates-to, m5->m1 depends-on.
insert into agent_memory.scopes (id, name) values ('a1000000-0000-0000-0000-0000000000a1', 's1'), ('a2000000-0000-0000-0000-0000000000a2', 's2');
insert into agent_memory.members (id, display_name, kind) values
  ('11111111-1111-1111-1111-111111111111', 'w', 'human'), ('22222222-2222-2222-2222-222222222222', 'r', 'human');
insert into agent_memory.scope_grants (scope_id, member_id, access) values
  ('a1000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'write'), ('a2000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'write'), ('a1000000-0000-0000-0000-0000000000a1', '22222222-2222-2222-2222-222222222222', 'read');
insert into agent_memory.memories (id, scope_id, content, category, created_by, updated_by, embedding)
select ('aaaaaaaa-0000-0000-0000-00000000000' || n)::uuid,
       case when n in (3, 5) then 'a2000000-0000-0000-0000-0000000000a2'::uuid else 'a1000000-0000-0000-0000-0000000000a1'::uuid end,
       'm' || n, 'other', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', array_fill(0.1::real, array[384])::extensions.vector
from generate_series(1, 5) n;
insert into agent_memory.memory_links (from_id, to_id, type, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'depends-on', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003', 'depends-on', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'derived-from', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000004', 'relates-to', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'depends-on', '11111111-1111-1111-1111-111111111111');

select ok(not has_function_privilege('anon', 'agent_memory.memory_neighbours(uuid, text, text[], int, uuid[], int)', 'execute'),
  'anon cannot execute memory_neighbours');
select ok(not has_function_privilege('anon', 'agent_memory.memory_links_for(uuid[])', 'execute'),
  'anon cannot execute memory_links_for');

-- As w
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select is((select array_agg(id order by id) from agent_memory.memory_neighbours('aaaaaaaa-0000-0000-0000-000000000001', 'out', null, 1, array['a1000000-0000-0000-0000-0000000000a1','a2000000-0000-0000-0000-0000000000a2']::uuid[], 100)), array['aaaaaaaa-0000-0000-0000-000000000002']::uuid[], 'depth 1 out from m1 is m2');
select is((select path from agent_memory.memory_neighbours('aaaaaaaa-0000-0000-0000-000000000001', 'out', null, 1, array['a1000000-0000-0000-0000-0000000000a1','a2000000-0000-0000-0000-0000000000a2']::uuid[], 100)),
  '[{"type":"depends-on","direction":"out","memoryId":"aaaaaaaa-0000-0000-0000-000000000002"}]'::jsonb, 'the path names the step');
select is((select array_agg(id order by id) from agent_memory.memory_neighbours('aaaaaaaa-0000-0000-0000-000000000001', 'both', null, 3, array['a1000000-0000-0000-0000-0000000000a1','a2000000-0000-0000-0000-0000000000a2']::uuid[], 100)), array['aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000005']::uuid[], 'depth 3 both reaches each memory once and terminates despite the cycle');
select is((select depth from agent_memory.memory_neighbours('aaaaaaaa-0000-0000-0000-000000000001', 'both', null, 3, array['a1000000-0000-0000-0000-0000000000a1','a2000000-0000-0000-0000-0000000000a2']::uuid[], 100) where id = 'aaaaaaaa-0000-0000-0000-000000000004'), 2, 'm4 is two hops away');
select is((select array_agg(id order by id) from agent_memory.memory_neighbours('aaaaaaaa-0000-0000-0000-000000000001', 'in', null, 1, array['a1000000-0000-0000-0000-0000000000a1','a2000000-0000-0000-0000-0000000000a2']::uuid[], 100)), array['aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000005']::uuid[], 'depth 1 in from m1 is m3 and m5');
select is((select array_agg(id order by id) from agent_memory.memory_neighbours('aaaaaaaa-0000-0000-0000-000000000001', 'out', array['depends-on'], 3, array['a1000000-0000-0000-0000-0000000000a1','a2000000-0000-0000-0000-0000000000a2']::uuid[], 100)), array['aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003']::uuid[], 'the type filter follows depends-on only');
select is((select pg_catalog.jsonb_array_length(path) from agent_memory.memory_neighbours('aaaaaaaa-0000-0000-0000-000000000001', 'out', array['depends-on'], 3, array['a1000000-0000-0000-0000-0000000000a1','a2000000-0000-0000-0000-0000000000a2']::uuid[], 100) where id = 'aaaaaaaa-0000-0000-0000-000000000003'), 2, 'm3 is reached by a two-step path');
select is((select path from agent_memory.memory_neighbours('aaaaaaaa-0000-0000-0000-000000000004', 'out', null, 1, array['a1000000-0000-0000-0000-0000000000a1','a2000000-0000-0000-0000-0000000000a2']::uuid[], 100)),
  '[{"type":"relates-to","direction":"both","memoryId":"aaaaaaaa-0000-0000-0000-000000000003"}]'::jsonb, 'relates-to matches an out filter and reads as both');
select is((select array_agg(id order by id) from agent_memory.memory_neighbours('aaaaaaaa-0000-0000-0000-000000000001', 'both', null, 3, array['a1000000-0000-0000-0000-0000000000a1']::uuid[], 100)), array['aaaaaaaa-0000-0000-0000-000000000002']::uuid[], 'scopes limit the walk: s2 memories are neither returned nor walked through');
select is((select count(*) from agent_memory.memory_neighbours('aaaaaaaa-0000-0000-0000-000000000001', 'both', null, 3, array['a1000000-0000-0000-0000-0000000000a1','a2000000-0000-0000-0000-0000000000a2']::uuid[], 1)), 1::bigint, 'the limit caps the rows');
select is((select max(depth) from agent_memory.memory_neighbours('aaaaaaaa-0000-0000-0000-000000000001', 'both', null, 3, array['a1000000-0000-0000-0000-0000000000a1','a2000000-0000-0000-0000-0000000000a2']::uuid[], 3)), 1, 'nearer memories win when the limit cuts the result');
reset role;

-- As r (reads s1 only)
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select is((select array_agg(id order by id) from agent_memory.memory_neighbours('aaaaaaaa-0000-0000-0000-000000000001', 'both', null, 3, array['a1000000-0000-0000-0000-0000000000a1','a2000000-0000-0000-0000-0000000000a2']::uuid[], 100)), array['aaaaaaaa-0000-0000-0000-000000000002']::uuid[], 'r sees only the readable part of the graph');
reset role;

-- links_for as w
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select is((select array_agg(other_id::text || ' ' || direction order by other_id) from agent_memory.memory_links_for(array['aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000003']::uuid[]) where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  array['aaaaaaaa-0000-0000-0000-000000000002 out', 'aaaaaaaa-0000-0000-0000-000000000003 in', 'aaaaaaaa-0000-0000-0000-000000000005 in'], 'links for m1');
select is((select array_agg(other_id::text || ' ' || direction order by other_id) from agent_memory.memory_links_for(array['aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000003']::uuid[]) where memory_id = 'aaaaaaaa-0000-0000-0000-000000000003'),
  array['aaaaaaaa-0000-0000-0000-000000000001 out', 'aaaaaaaa-0000-0000-0000-000000000002 in', 'aaaaaaaa-0000-0000-0000-000000000004 both'], 'links for m3, relates-to reads as both');
select is((select count(*) from agent_memory.memory_links_for('{}'::uuid[])), 0::bigint, 'no ids, no rows');
reset role;

-- links_for as r
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select is((select array_agg(other_id::text || ' ' || direction order by other_id) from agent_memory.memory_links_for(array['aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000003']::uuid[]) where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  array['aaaaaaaa-0000-0000-0000-000000000002 out'], 'r sees only the link whose both ends it can read');
select is((select count(*) from agent_memory.memory_links_for(array['aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000003']::uuid[]) where memory_id in ('aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000005') or other_id in ('aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000005')),
  0::bigint, 'nothing mentions the unreadable memories');
reset role;

-- Soft delete hides links and ends the walk
update agent_memory.memories set deleted_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000002';
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.memory_neighbours('aaaaaaaa-0000-0000-0000-000000000001', 'out', array['depends-on'], 3, array['a1000000-0000-0000-0000-0000000000a1','a2000000-0000-0000-0000-0000000000a2']::uuid[], 100)), 0::bigint, 'a soft-deleted memory ends the walk');
select is((select array_agg(other_id::text || ' ' || direction order by other_id) from agent_memory.memory_links_for(array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[])),
  array['aaaaaaaa-0000-0000-0000-000000000003 in', 'aaaaaaaa-0000-0000-0000-000000000005 in'], 'a soft-deleted end drops out of links_for');
reset role;

select * from finish();
rollback;
