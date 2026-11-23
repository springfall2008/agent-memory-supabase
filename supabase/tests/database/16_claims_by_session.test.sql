begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

-- Fixtures (as postgres). w and w2 both write s1. w has sessions w-a, w-b and one with no label; w2 has w2-a.
insert into agent_memory.scopes (id, name) values ('a1000000-0000-0000-0000-0000000000a1', 's1');
insert into agent_memory.members (id, display_name, kind) values
  ('11111111-1111-1111-1111-111111111111', 'w', 'human'), ('22222222-2222-2222-2222-222222222222', 'w2', 'human');
insert into agent_memory.scope_grants (scope_id, member_id, access) values
  ('a1000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'write'),
  ('a1000000-0000-0000-0000-0000000000a1', '22222222-2222-2222-2222-222222222222', 'write');
insert into agent_memory.memories (id, scope_id, content, category, created_by, updated_by, embedding)
select ('aaaaaaaa-0000-0000-0000-00000000000' || n)::uuid, 'a1000000-0000-0000-0000-0000000000a1', 'm' || n, 'other',
       '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', array_fill(0.1::real, array[384])::extensions.vector
from generate_series(1, 6) n;
insert into agent_memory.agent_sessions (id, member_id, label) values
  ('51111111-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'w-a'),
  ('51111111-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'w-b'),
  ('51111111-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111', null),
  ('52222222-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222', 'w2-a');

select ok(not has_function_privilege('anon', 'agent_memory.release_claim(uuid, boolean, uuid)', 'execute'),
  'anon cannot execute release_claim');
select ok(not has_function_privilege('agent_memory_member', 'agent_memory.claim_held_message(agent_memory.memory_claims, uuid)', 'execute'),
  'members cannot call the message helper');

-- Same member, same session renews; another session of the same member is refused
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select lives_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'parser work', 60, false, false, '51111111-0000-0000-0000-00000000000a'::uuid)$$, 'w-a claims m1');
select ok((select overridden_by is null from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'parser work 2', 60, false, false, '51111111-0000-0000-0000-00000000000a'::uuid)),
  'the same session renews');
select throws_like($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'me too', 60, false, false, '51111111-0000-0000-0000-00000000000b'::uuid)$$,
  'Memory aaaaaaaa-0000-0000-0000-000000000001 is claimed by your session ''w-a'' until %: parser work 2', 'another session of the same member is refused');
select throws_like($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'me too', 60, false, false, null)$$,
  'Memory aaaaaaaa-0000-0000-0000-000000000001 is claimed by your session ''w-a'' until %: parser work 2', 'a call with no session is refused too');
select is((select overridden_by || '|' || overridden_session_label || '|' || overridden_session_id::text from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'taking over', 60, false, true, '51111111-0000-0000-0000-00000000000b'::uuid)),
  'w|w-a|51111111-0000-0000-0000-00000000000a', 'force over an own other session reports it');

-- No session is its own identity
select lives_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000002', 'no session', 60, false, false, null)$$, 'w claims m2 with no session');
select lives_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000002', 'no session again', 60, false, false, null)$$, 'no session renews no session');
select throws_like($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000002', 'x', 60, false, false, '51111111-0000-0000-0000-00000000000a'::uuid)$$,
  'Memory aaaaaaaa-0000-0000-0000-000000000002 is claimed by you without a session until %: no session again', 'a session does not match a session-less claim');

-- Indefinite and unlabelled sessions in the message
select lives_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000003', 'long job', null, true, false, '51111111-0000-0000-0000-00000000000a'::uuid)$$, 'w-a claims m3 indefinitely');
select throws_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000003', 'x', 60, false, false, '51111111-0000-0000-0000-00000000000b'::uuid)$$, 'P0001',
  'Memory aaaaaaaa-0000-0000-0000-000000000003 is claimed by your session ''w-a'' indefinitely: long job', 'an indefinite claim names the session');
select lives_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000004', 'unlabelled', 60, false, false, '51111111-0000-0000-0000-00000000000c'::uuid)$$, 'an unlabelled session claims m4');
select throws_like($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000004', 'x', 60, false, false, '51111111-0000-0000-0000-00000000000a'::uuid)$$,
  'Memory aaaaaaaa-0000-0000-0000-000000000004 is claimed by your session ''51111111-0000-0000-0000-00000000000c'' until %', 'an unlabelled session is named by its id');
select lives_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000005', 'w on m5', 60, false, false, '51111111-0000-0000-0000-00000000000a'::uuid)$$, 'w-a claims m5');
reset role;

-- Another member: unchanged, and never sees the holder's session
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select throws_like($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'x', 60, false, false, '52222222-0000-0000-0000-00000000000a'::uuid)$$,
  'Memory aaaaaaaa-0000-0000-0000-000000000001 is claimed by w until %: taking over', 'another member is refused as before');
select ok((select overridden_by = 'w' and overridden_session_id is null and overridden_session_label is null
  from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000005', 'x', 60, false, true, '52222222-0000-0000-0000-00000000000a'::uuid)),
  'forcing over another member never shows their session');
select throws_like($$select agent_memory.release_claim('aaaaaaaa-0000-0000-0000-000000000001', false, null)$$,
  'Memory aaaaaaaa-0000-0000-0000-000000000001 is claimed by w until %: taking over; pass force to release it', 'another member''s release needs force');
reset role;

-- Release follows the same rule
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select throws_like($$select agent_memory.release_claim('aaaaaaaa-0000-0000-0000-000000000003', false, '51111111-0000-0000-0000-00000000000b'::uuid)$$,
  'Memory aaaaaaaa-0000-0000-0000-000000000003 is claimed by your session ''w-a'' indefinitely: long job; release it from that session, or pass force to release it anyway', 'another session''s release points to the holding session');
select is(agent_memory.release_claim('aaaaaaaa-0000-0000-0000-000000000003', true, '51111111-0000-0000-0000-00000000000b'::uuid), true, 'with force it is released');
select is(agent_memory.release_claim('aaaaaaaa-0000-0000-0000-000000000001', false, '51111111-0000-0000-0000-00000000000b'::uuid), true, 'the holding session releases');
select is(agent_memory.release_claim('aaaaaaaa-0000-0000-0000-000000000002', false, null), true, 'no session releases a session-less claim');
reset role;
update agent_memory.memory_claims set claimed_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
  where memory_id = 'aaaaaaaa-0000-0000-0000-000000000004';
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select is(agent_memory.release_claim('aaaaaaaa-0000-0000-0000-000000000004', false, '51111111-0000-0000-0000-00000000000a'::uuid), false,
  'an expired leftover is removed and reports false');
reset role;

select * from finish();
rollback;
