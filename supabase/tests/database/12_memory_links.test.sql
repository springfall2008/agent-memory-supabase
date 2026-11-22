begin;
create extension if not exists pgtap with schema extensions;
select plan(45);

-- Fixtures (as postgres). Members: w writes s1+s2; a writes s1, reads s2; b reads s1, writes s2; r reads s1; o has no grants.
-- Memories: m1, m2, m6 and 100 extras ('bbbbbbbb-...') in s1; m3 in s2. m6 already has 100 outgoing links.
insert into agent_memory.scopes (id, name) values
  ('a1000000-0000-0000-0000-0000000000a1', 's1'),
  ('a2000000-0000-0000-0000-0000000000a2', 's2');
insert into agent_memory.members (id, display_name, kind) values
  ('11111111-1111-1111-1111-111111111111', 'w', 'human'),
  ('22222222-2222-2222-2222-222222222222', 'a', 'human'),
  ('33333333-3333-3333-3333-333333333333', 'b', 'human'),
  ('44444444-4444-4444-4444-444444444444', 'r', 'human'),
  ('55555555-5555-5555-5555-555555555555', 'o', 'human');
insert into agent_memory.scope_grants (scope_id, member_id, access) values
  ('a1000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'write'),
  ('a2000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'write'),
  ('a1000000-0000-0000-0000-0000000000a1', '22222222-2222-2222-2222-222222222222', 'write'),
  ('a2000000-0000-0000-0000-0000000000a2', '22222222-2222-2222-2222-222222222222', 'read'),
  ('a1000000-0000-0000-0000-0000000000a1', '33333333-3333-3333-3333-333333333333', 'read'),
  ('a2000000-0000-0000-0000-0000000000a2', '33333333-3333-3333-3333-333333333333', 'write'),
  ('a1000000-0000-0000-0000-0000000000a1', '44444444-4444-4444-4444-444444444444', 'read');
insert into agent_memory.memories (id, scope_id, content, category, created_by, updated_by, embedding) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-0000000000a1', 'm1', 'other',
   '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   array_fill(0.1::real, array[384])::extensions.vector),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-0000000000a1', 'm2', 'other',
   '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   array_fill(0.1::real, array[384])::extensions.vector),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'a2000000-0000-0000-0000-0000000000a2', 'm3', 'other',
   '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   array_fill(0.1::real, array[384])::extensions.vector),
  ('aaaaaaaa-0000-0000-0000-000000000006', 'a1000000-0000-0000-0000-0000000000a1', 'm6', 'other',
   '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   array_fill(0.1::real, array[384])::extensions.vector);
insert into agent_memory.memories (id, scope_id, content, category, created_by, updated_by, embedding)
select ('bbbbbbbb-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, 'a1000000-0000-0000-0000-0000000000a1',
       'extra ' || i, 'other', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
       array_fill(0.1::real, array[384])::extensions.vector
from generate_series(1, 100) i;
insert into agent_memory.memory_links (from_id, to_id, type, created_by)
select 'aaaaaaaa-0000-0000-0000-000000000006', id, 'depends-on', '11111111-1111-1111-1111-111111111111'
from agent_memory.memories where id::text like 'bbbbbbbb-%';

-- Privileges
select ok(not has_function_privilege('anon', 'agent_memory.relate_memories(uuid, uuid, text)', 'execute'),
  'anon cannot execute relate_memories');
select ok(not has_function_privilege('anon', 'agent_memory.unrelate_memories(uuid, uuid, text)', 'execute'),
  'anon cannot execute unrelate_memories');

-- Table constraints (as postgres)
select throws_ok($$insert into agent_memory.memory_links (from_id, to_id, type, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'relates-to', '11111111-1111-1111-1111-111111111111')$$,
  '23514', null, 'a self link violates the check constraint');
select throws_ok($$insert into agent_memory.memory_links (from_id, to_id, type, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'nope', '11111111-1111-1111-1111-111111111111')$$,
  '23514', null, 'an unknown link type violates the check constraint');
insert into agent_memory.memory_links (from_id, to_id, type, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'relates-to', '11111111-1111-1111-1111-111111111111');
select throws_ok($$insert into agent_memory.memory_links (from_id, to_id, type, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'relates-to', '11111111-1111-1111-1111-111111111111')$$,
  '23505', null, 'the reversed relates-to pair is a unique violation');
delete from agent_memory.memory_links
  where from_id = 'aaaaaaaa-0000-0000-0000-000000000001' and to_id = 'aaaaaaaa-0000-0000-0000-000000000002';

-- As a (writes s1, reads s2)
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select throws_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'supersedes')$$,
  'P0001', 'No write access to scope ''s2''', 'supersedes needs write on the to-end scope too');
select lives_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'derived-from')$$,
  'derived-from needs write on from and only read on to');
reset role;

-- As w (writes both)
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select lives_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'supersedes')$$,
  'supersedes works with write on both scopes');
select throws_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'relates-to')$$,
  'P0001', 'A memory cannot be linked to itself', 'self link refused');
select throws_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'nope')$$,
  'P0001', 'Invalid link type ''nope''', 'unknown type refused');
select lives_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'depends-on')$$,
  'depends-on created');
select lives_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'depends-on')$$,
  'repeating the same link is not an error');
select is((select count(*) from agent_memory.memory_links
  where from_id = 'aaaaaaaa-0000-0000-0000-000000000001' and to_id = 'aaaaaaaa-0000-0000-0000-000000000002' and type = 'depends-on'),
  1::bigint, 'the repeated link is one row');
select lives_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'relates-to')$$,
  'relates-to created');
select lives_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'relates-to')$$,
  'the reversed relates-to is accepted as a no-op');
select is((select count(*) from agent_memory.memory_links
  where type = 'relates-to' and from_id in ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002')
    and to_id in ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002')),
  1::bigint, 'a relates-to pair is one row whichever way it was given');
select is(agent_memory.unrelate_memories('aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'relates-to'),
  true, 'unrelate in the opposite orientation removes the relates-to row');
select is((select count(*) from agent_memory.memory_links
  where type = 'relates-to' and from_id in ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002')
    and to_id in ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002')),
  0::bigint, 'and none is left');
select throws_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'relates-to')$$,
  'P0001', 'Memory aaaaaaaa-0000-0000-0000-000000000006 already has 100 outgoing links', 'the 101st outgoing link is refused');
select lives_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000006', 'depends-on')$$,
  'incoming links are never capped');
reset role;

-- As b (reads s1, writes s2)
select set_config('agent_memory.member_id', '33333333-3333-3333-3333-333333333333', true);
set local role agent_memory_member;
select throws_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'derived-from')$$,
  'P0001', 'No write access to scope ''s1''', 'derived-from from a read-only scope is refused');
select lives_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'relates-to')$$,
  'relates-to needs write on either end');
select lives_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'depends-on')$$,
  'depends-on from a writable scope to a readable memory works');
-- b cannot write s1, so a relates-to given as m6 -> m3 must not be charged to m6's outgoing cap (m6 is at 100)
select lives_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000003', 'relates-to')$$,
  'a reader of m6''s scope cannot fill m6''s outgoing cap through relates-to');
select is((select count(*) from agent_memory.memory_links
  where from_id = 'aaaaaaaa-0000-0000-0000-000000000003' and to_id = 'aaaaaaaa-0000-0000-0000-000000000006' and type = 'relates-to'),
  1::bigint, 'the relates-to row is stored from the end the caller can write');
reset role;

-- As r (reads s1) and o (no grants)
select set_config('agent_memory.member_id', '44444444-4444-4444-4444-444444444444', true);
set local role agent_memory_member;
select throws_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'relates-to')$$,
  'P0001', 'No write access to scope ''s1''', 'a read-only member cannot link');
reset role;
select set_config('agent_memory.member_id', '55555555-5555-5555-5555-555555555555', true);
set local role agent_memory_member;
select throws_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'relates-to')$$,
  'P0001', 'Memory aaaaaaaa-0000-0000-0000-000000000001 not found', 'an unreadable id reads as not found');
select throws_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-0000000000ff', 'aaaaaaaa-0000-0000-0000-000000000002', 'relates-to')$$,
  'P0001', 'Memory aaaaaaaa-0000-0000-0000-0000000000ff not found', 'an absent id reads exactly the same');
reset role;

-- Removal needs write on either end's scope (recreate the m1->m3 supersedes link between calls)
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select is(agent_memory.unrelate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'supersedes'),
  true, 'a (writes the from scope) can remove it');
reset role;
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select lives_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'supersedes')$$,
  'w recreates the link');
reset role;
select set_config('agent_memory.member_id', '33333333-3333-3333-3333-333333333333', true);
set local role agent_memory_member;
select is(agent_memory.unrelate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'supersedes'),
  true, 'b (writes only the to scope) can remove it');
reset role;
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select lives_ok($$select agent_memory.relate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'supersedes')$$,
  'w recreates the link again');
reset role;
select set_config('agent_memory.member_id', '44444444-4444-4444-4444-444444444444', true);
set local role agent_memory_member;
select throws_ok($$select agent_memory.unrelate_memories('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'supersedes')$$,
  'P0001', 'Memory aaaaaaaa-0000-0000-0000-000000000003 not found', 'r cannot read s2 so removal reads as not found');
reset role;

-- Visibility of the m1->m3 supersedes link
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.memory_links
  where from_id = 'aaaaaaaa-0000-0000-0000-000000000001' and to_id = 'aaaaaaaa-0000-0000-0000-000000000003' and type = 'supersedes'),
  1::bigint, 'w sees the link');
reset role;
select set_config('agent_memory.member_id', '44444444-4444-4444-4444-444444444444', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.memory_links
  where from_id = 'aaaaaaaa-0000-0000-0000-000000000001' and to_id = 'aaaaaaaa-0000-0000-0000-000000000003' and type = 'supersedes'),
  0::bigint, 'r, who cannot read the to end, sees nothing');
reset role;
select set_config('agent_memory.member_id', '55555555-5555-5555-5555-555555555555', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.memory_links), 0::bigint, 'o sees no links at all');
reset role;
update agent_memory.memories set deleted_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000003';
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.memory_links
  where from_id = 'aaaaaaaa-0000-0000-0000-000000000001' and to_id = 'aaaaaaaa-0000-0000-0000-000000000003' and type = 'supersedes'),
  0::bigint, 'soft-deleting an end hides the link');
reset role;
update agent_memory.memories set deleted_at = null where id = 'aaaaaaaa-0000-0000-0000-000000000003';
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.memory_links
  where from_id = 'aaaaaaaa-0000-0000-0000-000000000001' and to_id = 'aaaaaaaa-0000-0000-0000-000000000003' and type = 'supersedes'),
  1::bigint, 'restoring the end brings the link back');
select throws_ok($$insert into agent_memory.memory_links (from_id, to_id, type, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'relates-to', '11111111-1111-1111-1111-111111111111')$$,
  '42501', null, 'members cannot insert links directly');
reset role;
update agent_memory.memories set scope_id = 'a1000000-0000-0000-0000-0000000000a1'
  where id = 'aaaaaaaa-0000-0000-0000-000000000003';
select set_config('agent_memory.member_id', '44444444-4444-4444-4444-444444444444', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.memory_links
  where from_id = 'aaaaaaaa-0000-0000-0000-000000000001' and to_id = 'aaaaaaaa-0000-0000-0000-000000000003' and type = 'supersedes'),
  1::bigint, 'moving an end into a readable scope makes the link visible');
reset role;

-- Purge removes links through the foreign key
delete from agent_memory.memories where id = 'aaaaaaaa-0000-0000-0000-000000000003';
select is((select count(*) from agent_memory.memory_links
  where from_id = 'aaaaaaaa-0000-0000-0000-000000000003' or to_id = 'aaaaaaaa-0000-0000-0000-000000000003'),
  0::bigint, 'purging a memory deletes its links');

-- Erase and tombstone purge remove a memory's links too (as postgres, like the erase tests)
insert into agent_memory.memories (id, scope_id, content, category, created_by, updated_by, embedding)
select v.id::uuid, 'a1000000-0000-0000-0000-0000000000a1', v.content, 'other',
  '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
  array_fill(0.1::real, array[384])::extensions.vector
from (values ('aaaaaaaa-0000-0000-0000-000000000008', 'm8'), ('aaaaaaaa-0000-0000-0000-000000000009', 'm9')) as v(id, content);
insert into agent_memory.memory_links (from_id, to_id, type, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000008', 'depends-on', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001', 'supersedes', '11111111-1111-1111-1111-111111111111');
select is(agent_memory.erase('aaaaaaaa-0000-0000-0000-000000000008'), true, 'erase of a linked memory returns true');
select is((select count(*) from agent_memory.memory_links
  where from_id = 'aaaaaaaa-0000-0000-0000-000000000008' or to_id = 'aaaaaaaa-0000-0000-0000-000000000008'),
  0::bigint, 'erase leaves no links behind');
update agent_memory.memories set deleted_at = now() - interval '31 days' where id = 'aaaaaaaa-0000-0000-0000-000000000009';
select is(agent_memory.purge_tombstones(), 1, 'the tombstone purge removes the expired memory');
select is((select count(*) from agent_memory.memory_links
  where from_id = 'aaaaaaaa-0000-0000-0000-000000000009' or to_id = 'aaaaaaaa-0000-0000-0000-000000000009'),
  0::bigint, 'the tombstone purge leaves no links behind');

select * from finish();
rollback;
