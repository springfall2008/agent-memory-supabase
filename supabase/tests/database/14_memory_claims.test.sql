begin;
create extension if not exists pgtap with schema extensions;
select plan(41);

-- Fixtures (as postgres). w writes s1+s2; w2 writes s1; r reads s1; o has no grants; d writes s1 (deactivated later).
-- Memories: m1, m2, m3, m5, m6 in s1; m4 in s2. Sessions w-a, w-b for w; w2-a for w2.
insert into agent_memory.scopes (id, name) values ('a1000000-0000-0000-0000-0000000000a1', 's1'), ('a2000000-0000-0000-0000-0000000000a2', 's2');
insert into agent_memory.members (id, display_name, kind) values
  ('11111111-1111-1111-1111-111111111111', 'w', 'human'), ('22222222-2222-2222-2222-222222222222', 'w2', 'human'), ('44444444-4444-4444-4444-444444444444', 'r', 'human'), ('55555555-5555-5555-5555-555555555555', 'o', 'human'), ('66666666-6666-6666-6666-666666666666', 'd', 'bot');
insert into agent_memory.scope_grants (scope_id, member_id, access) values
  ('a1000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'write'), ('a2000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'write'), ('a1000000-0000-0000-0000-0000000000a1', '22222222-2222-2222-2222-222222222222', 'write'), ('a1000000-0000-0000-0000-0000000000a1', '44444444-4444-4444-4444-444444444444', 'read'),
  ('a1000000-0000-0000-0000-0000000000a1', '66666666-6666-6666-6666-666666666666', 'write');
insert into agent_memory.memories (id, scope_id, content, category, created_by, updated_by, embedding)
select ('aaaaaaaa-0000-0000-0000-00000000000' || n)::uuid,
       case when n = 4 then 'a2000000-0000-0000-0000-0000000000a2'::uuid else 'a1000000-0000-0000-0000-0000000000a1'::uuid end,
       'm' || n, 'other', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', array_fill(0.1::real, array[384])::extensions.vector
from generate_series(1, 6) n;
insert into agent_memory.agent_sessions (id, member_id, label) values
  ('51111111-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'w-a'), ('51111111-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'w-b'), ('52222222-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222', 'w2-a');

select ok(not has_function_privilege('anon', 'agent_memory.claim_memory(uuid, text, int, boolean, boolean, uuid)', 'execute'),
  'anon cannot execute claim_memory');
select ok(not has_function_privilege('anon', 'agent_memory.release_claim(uuid, boolean)', 'execute'),
  'anon cannot execute release_claim');

-- Validation and access
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select throws_ok($$insert into agent_memory.memory_claims (memory_id, member_id, description) values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'x')$$,
  '42501', null, 'members cannot insert claims directly');
select throws_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', '   ', 60, false, false, null)$$, 'P0001', 'Description must be 1-200 characters', 'a blank description is refused');
select throws_ok(format($f$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', %L, 60, false, false, null)$f$, repeat('x', 201)),
  'P0001', 'Description must be 1-200 characters', 'a 201-character description is refused');
select throws_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'x', 5, true, false, null)$$, 'P0001', 'Pass minutes or indefinite, not both', 'minutes and indefinite together are refused');
select throws_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'x', 0, false, false, null)$$, 'P0001', 'minutes must be between 1 and 5256000', 'zero minutes refused');
select throws_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'x', 5256001, false, false, null)$$, 'P0001', 'minutes must be between 1 and 5256000', 'over ten years refused');
reset role;
select set_config('agent_memory.member_id', '44444444-4444-4444-4444-444444444444', true);
set local role agent_memory_member;
select throws_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'x', 60, false, false, null)$$, 'P0001', 'No write access to scope ''s1''', 'a reader cannot claim');
reset role;
select set_config('agent_memory.member_id', '55555555-5555-5555-5555-555555555555', true);
set local role agent_memory_member;
select throws_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'x', 60, false, false, null)$$, 'P0001', 'Memory aaaaaaaa-0000-0000-0000-000000000001 not found', 'an unreadable memory reads as not found');
select throws_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-0000000000ff', 'x', 60, false, false, null)$$, 'P0001', 'Memory aaaaaaaa-0000-0000-0000-0000000000ff not found', 'an absent memory reads exactly the same');
reset role;

-- Claim, conflict, renewal, force
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select ok((select overridden_by is null and expires_at between now() + interval '59 minutes' and now() + interval '61 minutes'
  from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', '  fixing the parser  ', 60, false, false, '51111111-0000-0000-0000-00000000000a'::uuid)), 'w claims m1 for an hour');
select is((select description from agent_memory.memory_claims where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'fixing the parser', 'the description is stored trimmed');
reset role;
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select throws_like($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'me too', 60, false, false, '52222222-0000-0000-0000-00000000000a'::uuid)$$,
  'Memory aaaaaaaa-0000-0000-0000-000000000001 is claimed by w until %: fixing the parser', 'another member is refused and told who holds it');
reset role;
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select is((select previous_session_label from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'second pass', 60, false, false, '51111111-0000-0000-0000-00000000000b'::uuid)), 'w-a',
  'a renewal from another session reports the previous one');
select is((select session_id from agent_memory.memory_claims where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001'), '51111111-0000-0000-0000-00000000000b'::uuid, 'the latest session is recorded');
select is((select previous_session_label from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'third pass', 30, false, false, null)), 'w-b',
  'a renewal with no session still reports the previous one');
select ok((select session_id is null from agent_memory.memory_claims where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'and records no session');
reset role;
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select is((select overridden_by || '|' || overridden_description from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'taking over', 60, false, true, '52222222-0000-0000-0000-00000000000a'::uuid)),
  'w|third pass', 'force takes over and reports the claim it replaced');
select is((select agent_memory.member_name(member_id) from agent_memory.memory_claims where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'w2',
  'the forcing member now holds it');
reset role;

-- Indefinite
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select ok((select expires_at is null from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000002', 'long ticket', null, true, false, null)), 'an indefinite claim has no end');
reset role;
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select throws_like($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000002', 'x', 60, false, false, null)$$,
  'Memory aaaaaaaa-0000-0000-0000-000000000002 is claimed by w indefinitely: long ticket', 'an indefinite claim blocks others');
reset role;

-- Expiry: an expired claim is free
update agent_memory.memory_claims set claimed_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
  where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001';
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select lives_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'after expiry', 60, false, false, null)$$, 'an expired claim can be taken without force');
reset role;

-- A deactivated holder's claim is inactive
select set_config('agent_memory.member_id', '66666666-6666-6666-6666-666666666666', true);
set local role agent_memory_member;
select lives_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000003', 'bot work', 60, false, false, null)$$, 'd claims m3');
reset role;
update agent_memory.members set deactivated_at = now() where id = '66666666-6666-6666-6666-666666666666';
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select lives_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000003', 'picking it up', 60, false, false, null)$$,
  'a deactivated member''s claim does not block');
reset role;

-- Rights change: the claim outlives the holder's access
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select lives_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000006', 'w2 work', 60, false, false, null)$$, 'w2 claims m6');
reset role;
delete from agent_memory.scope_grants where member_id = '22222222-2222-2222-2222-222222222222' and scope_id = 'a1000000-0000-0000-0000-0000000000a1';
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select throws_like($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000006', 'mine now', 60, false, false, null)$$, 'Memory aaaaaaaa-0000-0000-0000-000000000006 is claimed by w2 until %',
  'the claim still blocks after the holder lost access');
select lives_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000006', 'mine now', 60, false, true, null)$$, 'force clears it');
reset role;
insert into agent_memory.scope_grants (scope_id, member_id, access) values ('a1000000-0000-0000-0000-0000000000a1', '22222222-2222-2222-2222-222222222222', 'write');

-- Release
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select throws_ok($$select agent_memory.release_claim('aaaaaaaa-0000-0000-0000-000000000002', false)$$, 'P0001',
  'Memory aaaaaaaa-0000-0000-0000-000000000002 is claimed by w; pass force to release another member''s claim', 'releasing another member''s claim needs force');
select is(agent_memory.release_claim('aaaaaaaa-0000-0000-0000-000000000002', true), true, 'with force it is released');
select is(agent_memory.release_claim('aaaaaaaa-0000-0000-0000-000000000002', true), false, 'releasing an unclaimed memory reports false');
reset role;
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select is(agent_memory.release_claim('aaaaaaaa-0000-0000-0000-000000000001', false), true, 'the holder releases their own claim');
select lives_ok($$select * from agent_memory.claim_memory('aaaaaaaa-0000-0000-0000-000000000001', 'visible claim', 60, false, false, null)$$, 'w claims m1 again');
reset role;

-- Visibility
select set_config('agent_memory.member_id', '44444444-4444-4444-4444-444444444444', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.memory_claims where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 1::bigint, 'a reader of the memory sees its claim');
reset role;
select set_config('agent_memory.member_id', '55555555-5555-5555-5555-555555555555', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.memory_claims), 0::bigint, 'a member with no grants sees no claims');
reset role;
update agent_memory.memories set deleted_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select set_config('agent_memory.member_id', '44444444-4444-4444-4444-444444444444', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.memory_claims where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 0::bigint, 'a soft-deleted memory hides its claim');
reset role;
update agent_memory.memories set deleted_at = null where id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- Erase and tombstone purge remove claims
select is(agent_memory.erase('aaaaaaaa-0000-0000-0000-000000000003'), true, 'erase of a claimed memory');
select is((select count(*) from agent_memory.memory_claims where memory_id = 'aaaaaaaa-0000-0000-0000-000000000003'), 0::bigint, 'erase leaves no claim');
insert into agent_memory.memory_claims (memory_id, member_id, description) values ('aaaaaaaa-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'old');
update agent_memory.memories set deleted_at = now() - interval '31 days' where id = 'aaaaaaaa-0000-0000-0000-000000000005';
select is(agent_memory.purge_tombstones(), 1, 'the tombstone purge removes the expired memory');
select is((select count(*) from agent_memory.memory_claims where memory_id = 'aaaaaaaa-0000-0000-0000-000000000005'), 0::bigint, 'and its claim');

-- Claims are advisory: a claim never blocks an edit
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select lives_ok($$update agent_memory.memories set content = content || ' edited', updated_by = '22222222-2222-2222-2222-222222222222' where id = 'aaaaaaaa-0000-0000-0000-000000000006'$$,
  'another writer can still edit a claimed memory');
reset role;

select * from finish();
rollback;
