import { randomBytes } from 'node:crypto'
import type { ContainerHostnames, ContainerOwner } from '../ports/container-hostnames.js'
import { AdvisoryLock, transactionSharedLock } from './advisory-locks.js'
import { repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'

/** First writer wins for the current stable space; account deletion retires the value. */
export class PostgresContainerHostnames implements ContainerHostnames {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async get(owner: ContainerOwner): Promise<string> {
    const saved = await this.remember(owner, `phalanx-${randomBytes(12).toString('hex')}`)
    if (!saved) throw new Error('The container user space changed')
    return saved
  }
  async remember(owner: ContainerOwner, hostname: string): Promise<string | undefined> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(owner.username) || !/^[a-f0-9]{32}$/u.test(owner.spaceId)) throw new Error('Invalid container owner')
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,62}[a-zA-Z0-9])?$/u.test(hostname)) throw new Error('Invalid saved container hostname')
    return await repositoryTransaction(this.connection, async sql => {
      await sql.query(transactionSharedLock(AdvisoryLock.accounts))
      const current = await sql.query('SELECT space_id FROM dsh_phalanx.accounts WHERE username=$1 AND space_id=$2 FOR KEY SHARE', [
        owner.username,
        owner.spaceId,
      ])
      if (!current.length) return undefined
      await sql.query('INSERT INTO dsh_phalanx.container_hostnames(space_id,hostname) VALUES($1,$2) ON CONFLICT(space_id) DO NOTHING', [
        owner.spaceId,
        hostname,
      ])
      return (await sql.query<{ hostname: string }>('SELECT hostname FROM dsh_phalanx.container_hostnames WHERE space_id=$1', [owner.spaceId]))[0]!.hostname
    })
  }
}
