import { createHash } from 'node:crypto'
import type { PlatformDatabase } from '../../src/adapters/platform-database.js'
import { PostgresCommunityAccountStore } from '../../src/adapters/postgres-community-accounts.js'

/** Explicit real policy parents for storage fixtures; no production writer invents missing owners. */
export async function seedMcpParents(
  database: PlatformDatabase,
  input: { readonly groups?: readonly string[]; readonly spaces?: readonly string[] },
): Promise<void> {
  for (const id of input.groups ?? [])
    await database.query("INSERT INTO dsh_phalanx.groups(id,name,kind) VALUES($1,$2,'ordinary') ON CONFLICT(id) DO NOTHING", [id, 'Fixture ' + id])
  const accounts = new PostgresCommunityAccountStore(database)
  for (const space of input.spaces ?? []) {
    if ((await database.query('SELECT 1 FROM dsh_phalanx.accounts WHERE space_id=$1', [space])).length) continue
    const username = 'fixture-' + createHash('sha256').update(space).digest('hex').slice(0, 16)
    await accounts.create({ username, password: 'fixture-password', email: '' })
    await database.query('UPDATE dsh_phalanx.accounts SET space_id=$2,storage_key=$2 WHERE username=$1', [username, space])
  }
}
