begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

-- Fixtures (as postgres). w writes s1 and reads s2; w2 writes s1; o has no grants; nobody but postgres sees s3.
-- Candidates for w on tag status:open, oldest first: m1 (s2, not writable), m2 (deleted), m3 (superseded by m6),
-- m4, m5 (superseded only by m9 in unreadable s3), m7 (expired leftover claim by w2), m6, m8 (category learning, kind:hint).
insert into agent_memory.scopes (id, name) values
  ('a1000000-0000-0000-0000-0000000000a1', 's1'), ('a2000000-0000-0000-0000-0000000000a2', 's2'), ('a3000000-0000-0000-0000-0000000000a3', 's3');
insert into agent_memory.members (id, display_name, kind) values
  ('11111111-1111-1111-1111-111111111111', 'w', 'human'), ('22222222-2222-2222-2222-222222222222', 'w2', 'human'),
  ('55555555-5555-5555-5555-555555555555', 'o', 'human');
insert into agent_memory.scope_grants (scope_id, member_id, access) values
  ('a1000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'write'),
  ('a2000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'read'),
  ('a1000000-0000-0000-0000-0000000000a1', '22222222-2222-2222-2222-222222222222', 'write');
insert into agent_memory.memories (id, scope_id, content, category, tags, created_by, updated_by, embedding, created_at)
select ('aaaaaaaa-0000-0000-0000-00000000000' || n)::uuid,
       case n when 1 then 'a2000000-0000-0000-0000-0000000000a2'::uuid when 9 then 'a3000000-0000-0000-0000-0000000000a3'::uuid
              else 'a1000000-0000-0000-0000-0000000000a1'::uuid end,
       'm' || n, case when n = 8 then 'learning' else 'other' end,
       case when n = 8 then array['status:open', 'kind:hint'] else array['status:open', 'kind:intent'] end,
       '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', array_fill(0.1::real, array[384])::extensions.vector,
       now() - make_interval(mins => case n when 1 then 10 when 2 then 9 when 3 then 8 when 4 then 7 when 5 then 6 when 7 then 5
                                             when 6 then 4 when 8 then 3 else 1 end)
from generate_series(1, 9) n;
update agent_memory.memories set deleted_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000002';
insert into agent_memory.memory_links (from_id, to_id, type, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000003', 'supersedes', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000005', 'supersedes', '11111111-1111-1111-1111-111111111111');
insert into agent_memory.memory_claims (memory_id, member_id, description, claimed_at, expires_at) values
  ('aaaaaaaa-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222222', 'old', now() - interval '2 hours', now() - interval '1 hour');
insert into agent_memory.agent_sessions (id, member_id, label) values
  ('51111111-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'w-a'),
  ('52222222-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222', 'w2-a');

select ok(not has_function_privilege('anon', 'agent_memory.claim_next(uuid[], text, text[], text[], text, int, boolean, uuid)', 'execute'),
  'anon cannot execute claim_next');

-- Validation
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select throws_ok($$select * from agent_memory.claim_next(null, null, array['status:open'], null, '  ', 60, false, null)$$, 'P0001', 'Description must be 1-200 characters', 'a blank description is refused');
select throws_ok($$select * from agent_memory.claim_next(null, null, array['status:open'], null, 'x', 5, true, null)$$, 'P0001', 'Pass minutes or indefinite, not both', 'minutes with indefinite is refused');
select throws_ok($$select * from agent_memory.claim_next(null, null, array['status:open'], null, 'x', 0, false, null)$$, 'P0001', 'minutes must be between 1 and 5256000', 'zero minutes refused');
select throws_ok($$select * from agent_memory.claim_next(null, null, null, null, 'x', 60, false, null)$$, 'P0001', 'Pass tags or tags_all', 'a call without tags is refused');
select throws_ok($$select * from agent_memory.claim_next(null, null, array['status:open'], null, 'x', 60, false, '52222222-0000-0000-0000-00000000000a'::uuid)$$, 'P0001', 'Session not found', 'another member''s session is refused');
reset role;

-- A member with no grants gets nothing and claims nothing
select set_config('agent_memory.member_id', '55555555-5555-5555-5555-555555555555', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.claim_next(null, null, array['status:open'], null, 'x', 60, false, null)), 0::bigint, 'no grants, no claim');
reset role;

-- Filters, then oldest free first
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select is((select memory_id from agent_memory.claim_next(null, 'learning', array['status:open'], null, 'hint', 60, false, null)),
  'aaaaaaaa-0000-0000-0000-000000000008'::uuid, 'the category filter narrows the choice');
select is((select count(*) from agent_memory.claim_next(null, null, null, array['status:open', 'kind:hint'], 'x', 60, false, null)), 0::bigint,
  'tags_all narrows the choice, and a memory I hold is never next');
select ok((select memory_id = 'aaaaaaaa-0000-0000-0000-000000000004' and expires_at between now() + interval '59 minutes' and now() + interval '61 minutes'
  from agent_memory.claim_next(null, null, array['status:open'], null, '  first  ', 60, false, '51111111-0000-0000-0000-00000000000a'::uuid)),
  'the oldest free writable memory comes first (m1 not writable, m2 deleted, m3 superseded)');
select is((select description || '|' || session_id::text || '|' || agent_memory.member_name(member_id) from agent_memory.memory_claims
  where memory_id = 'aaaaaaaa-0000-0000-0000-000000000004'), 'first|51111111-0000-0000-0000-00000000000a|w', 'the claim records description, session and member');
select is((select memory_id from agent_memory.claim_next(null, null, array['status:open'], null, 'second', 60, false, null)),
  'aaaaaaaa-0000-0000-0000-000000000005'::uuid, 'a supersedes link from an unreadable memory does not count');
select is((select memory_id from agent_memory.claim_next(null, null, array['status:open'], null, 'third', null, true, null)),
  'aaaaaaaa-0000-0000-0000-000000000007'::uuid, 'an expired leftover claim does not block');
select is((select count(*) from agent_memory.memory_claims where memory_id = 'aaaaaaaa-0000-0000-0000-000000000007'
  and member_id = '11111111-1111-1111-1111-111111111111' and expires_at is null), 1::bigint, 'and is replaced by an indefinite claim');
select is((select memory_id from agent_memory.claim_next(array['a1000000-0000-0000-0000-0000000000a1'::uuid], null, array['status:open'], null, 'fourth', 60, false, null)),
  'aaaaaaaa-0000-0000-0000-000000000006'::uuid, 'the scope filter is honoured');
select is((select count(*) from agent_memory.claim_next(null, null, array['status:open'], null, 'fifth', 60, false, null)), 0::bigint,
  'nothing free returns no row');
reset role;

-- Another member never takes a claimed memory either
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.claim_next(null, null, array['status:open'], null, 'x', 60, false, null)), 0::bigint,
  'every match is claimed, so another member gets nothing');
reset role;

-- A memory freed by expiry comes back
update agent_memory.memory_claims set claimed_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
  where memory_id = 'aaaaaaaa-0000-0000-0000-000000000004';
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select is((select memory_id from agent_memory.claim_next(null, null, array['kind:intent'], null, 'x', 60, false, null)),
  'aaaaaaaa-0000-0000-0000-000000000004'::uuid, 'an expired claim frees the memory for the next caller');
reset role;
select is((select count(*) from agent_memory.memory_claims), 5::bigint, 'one claim row per memory');

select * from finish();
rollback;
