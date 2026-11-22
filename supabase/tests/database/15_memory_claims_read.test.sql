begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

-- Fixtures (as postgres). w writes s1+s2; w2 writes s1; r reads s1; d writes s1 and is deactivated.
-- m1, m2, m3, m5, m6 in s1; m4, m7 in s2. Claims: m1 w (session w-a, 60 min), m2 w (indefinite), m3 w2 (30 min),
-- m4 w (expired), m5 d (60 min, d deactivated), m6 w (10 min), m7 w (20 min).
insert into agent_memory.scopes (id, name) values ('a1000000-0000-0000-0000-0000000000a1', 's1'), ('a2000000-0000-0000-0000-0000000000a2', 's2');
insert into agent_memory.members (id, display_name, kind) values
  ('11111111-1111-1111-1111-111111111111', 'w', 'human'), ('22222222-2222-2222-2222-222222222222', 'w2', 'human'), ('44444444-4444-4444-4444-444444444444', 'r', 'human'), ('66666666-6666-6666-6666-666666666666', 'd', 'bot');
insert into agent_memory.scope_grants (scope_id, member_id, access) values
  ('a1000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'write'), ('a2000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'write'), ('a1000000-0000-0000-0000-0000000000a1', '22222222-2222-2222-2222-222222222222', 'write'), ('a1000000-0000-0000-0000-0000000000a1', '44444444-4444-4444-4444-444444444444', 'read'), ('a1000000-0000-0000-0000-0000000000a1', '66666666-6666-6666-6666-666666666666', 'write');
insert into agent_memory.memories (id, scope_id, content, category, created_by, updated_by, embedding)
select ('aaaaaaaa-0000-0000-0000-00000000000' || n)::uuid,
       case when n in (4, 7) then 'a2000000-0000-0000-0000-0000000000a2'::uuid else 'a1000000-0000-0000-0000-0000000000a1'::uuid end,
       'm' || n, 'other', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', array_fill(0.1::real, array[384])::extensions.vector
from generate_series(1, 7) n;
insert into agent_memory.agent_sessions (id, member_id, label) values ('51111111-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'w-a');
insert into agent_memory.memory_claims (memory_id, member_id, session_id, description, claimed_at, expires_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '51111111-0000-0000-0000-00000000000a', 'one', now(), now() + interval '60 minutes'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', null, 'two', now(), null),
  ('aaaaaaaa-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', null, 'three', now(), now() + interval '30 minutes'),
  ('aaaaaaaa-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', null, 'four', now() - interval '2 hours', now() - interval '1 hour'),
  ('aaaaaaaa-0000-0000-0000-000000000005', '66666666-6666-6666-6666-666666666666', null, 'five', now(), now() + interval '60 minutes'),
  ('aaaaaaaa-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', null, 'six', now(), now() + interval '10 minutes'),
  ('aaaaaaaa-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', null, 'seven', now(), now() + interval '20 minutes');
update agent_memory.members set deactivated_at = now() where id = '66666666-6666-6666-6666-666666666666';

select ok(not has_function_privilege('anon', 'agent_memory.memory_claims_for(uuid[])', 'execute'),
  'anon cannot execute memory_claims_for');
select ok(not has_function_privilege('anon', 'agent_memory.my_claims(uuid[], int)', 'execute'),
  'anon cannot execute my_claims');

-- memory_claims_for as w
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.memory_claims_for(array['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000007']::uuid[])), 5::bigint,
  'only active claims of active holders: the expired m4 and the deactivated holder''s m5 are absent');
select is((select count(*) from agent_memory.memory_claims_for(array['aaaaaaaa-0000-0000-0000-000000000005']::uuid[])), 0::bigint,
  'a deactivated holder''s claim is inactive');
select is((select mine and session_label = 'w-a' from agent_memory.memory_claims_for(array['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000007']::uuid[]) where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001'), true,
  'the holder sees mine and their session');
select is((select holder || '|' || mine::text || '|' || coalesce(session_label, 'none')
  from agent_memory.memory_claims_for(array['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000007']::uuid[]) where memory_id = 'aaaaaaaa-0000-0000-0000-000000000003'), 'w2|false|none', 'another member''s claim shows the holder only');
select ok((select expires_at is null from agent_memory.memory_claims_for(array['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000007']::uuid[]) where memory_id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  'an indefinite claim has no end');
reset role;

-- memory_claims_for as w2 and r
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select ok((select session_id is null and session_label is null and not mine and holder = 'w'
  from agent_memory.memory_claims_for(array['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000007']::uuid[]) where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'other members never see the holder''s session');
reset role;
select set_config('agent_memory.member_id', '44444444-4444-4444-4444-444444444444', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.memory_claims_for(array['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000007']::uuid[])), 4::bigint, 'r sees the claims on memories it can read');
select is((select count(*) from agent_memory.memory_claims_for(array['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000007']::uuid[]) where memory_id = 'aaaaaaaa-0000-0000-0000-000000000007'), 0::bigint,
  'and none on a memory in a scope it cannot read');
reset role;

-- my_claims
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select is((select array_agg(c.memory_id order by c.ord) from agent_memory.my_claims(null, 100) with ordinality as c(memory_id, scope, category, tags, content, description, claimed_at, expires_at, session_id, session_label, ord)), array['aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002']::uuid[], 'my claims, soonest end first, indefinite last');
select is((select array_agg(c.memory_id order by c.ord) from agent_memory.my_claims(array['a2000000-0000-0000-0000-0000000000a2']::uuid[], 100) with ordinality as c(memory_id, scope, category, tags, content, description, claimed_at, expires_at, session_id, session_label, ord)), array['aaaaaaaa-0000-0000-0000-000000000007']::uuid[], 'scopes narrow my claims');
select is((select array_agg(c.memory_id order by c.ord) from agent_memory.my_claims(null, 1) with ordinality as c(memory_id, scope, category, tags, content, description, claimed_at, expires_at, session_id, session_label, ord)), array['aaaaaaaa-0000-0000-0000-000000000006']::uuid[], 'the limit caps my claims');
select is((select session_label || '|' || content from agent_memory.my_claims(null, 100) where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'w-a|m1',
  'my claims carry the session and the memory content');
reset role;
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select is((select array_agg(c.memory_id order by c.ord) from agent_memory.my_claims(null, 100) with ordinality as c(memory_id, scope, category, tags, content, description, claimed_at, expires_at, session_id, session_label, ord)), array['aaaaaaaa-0000-0000-0000-000000000003']::uuid[], 'w2 sees only its own claims');
reset role;

select * from finish();
rollback;
