import postgres from 'npm:postgres@3.4.5';

export const LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export type AdminSql = postgres.Sql;

export function adminSql(): AdminSql {
  return postgres(LOCAL_DB_URL, { max: 2, prepare: false });
}

export interface World {
  alpha: { id: string; name: string };
  beta: { id: string; name: string };
  rw: { id: string; name: string };
  ro: { id: string; name: string };
  none: { id: string; name: string };
  bw: { id: string; name: string };
  cleanup(): Promise<void>;
}

/** rw: write alpha; ro: read alpha; none: no grants; bw: write beta. Names are uniquely suffixed. */
export async function makeWorld(sql: AdminSql): Promise<World> {
  const sfx = crypto.randomUUID().slice(0, 8);
  const scope = async (name: string) => {
    const [r] = await sql`insert into agent_memory.scopes (name) values (${name}) returning id`;
    return { id: r.id as string, name };
  };
  const member = async (name: string, kind: string) => {
    const [r] = await sql`
      insert into agent_memory.members (display_name, kind) values (${name}, ${kind}) returning id`;
    return { id: r.id as string, name };
  };
  const alpha = await scope(`alpha-${sfx}`);
  const beta = await scope(`beta-${sfx}`);
  const rw = await member(`rw-${sfx}`, 'human');
  const ro = await member(`ro-${sfx}`, 'human');
  const none = await member(`none-${sfx}`, 'human');
  const bw = await member(`bw-${sfx}`, 'bot');
  const grant = (s: string, m: string, a: string) =>
    sql`insert into agent_memory.scope_grants (scope_id, member_id, access) values (${s}, ${m}, ${a})`;
  await grant(alpha.id, rw.id, 'write');
  await grant(alpha.id, ro.id, 'read');
  await grant(beta.id, bw.id, 'write');
  return {
    alpha,
    beta,
    rw,
    ro,
    none,
    bw,
    async cleanup() {
      const scopeIds = [alpha.id, beta.id];
      const memberIds = [rw.id, ro.id, none.id, bw.id];
      // Threads first (posts, links and subscriptions cascade); sessions cascade with members.
      await sql`delete from agent_memory.threads where scope_id = any(${scopeIds}::uuid[])`;
      // The history trigger writes a 'purge' row on delete, so clear history after the memories.
      const gone = await sql`delete from agent_memory.memories where scope_id = any(${scopeIds}::uuid[]) returning id`;
      await sql`delete from agent_memory.memory_history where memory_id = any(${gone.map((r) => r.id)}::uuid[])`;
      // Usage rows reference the member who recorded them.
      await sql`delete from agent_memory.board_usage where scope_id = any(${scopeIds}::uuid[])`;
      await sql`delete from agent_memory.members where id = any(${memberIds}::uuid[])`;
      await sql`delete from agent_memory.scopes where id = any(${scopeIds}::uuid[])`;
    },
  };
}
