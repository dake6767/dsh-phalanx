import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { OwnedCommunityContainers } from './community-containers.js'
import { FileCommunityUserSpaces } from './community-user-spaces.js'
import { FilePlatformDatabaseConfig } from './platform-database-config.js'
import { inspectPlatformDatabaseSession, platformDatabasePool } from './platform-database-inspection.js'
import type { PlatformSql } from './platform-database.js'
import { readCommunityUserSpace } from './postgres-community-accounts.js'
import { readUserStorageRecord } from './postgres-user-storage-facts.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'
import { UserStorageGuard } from './user-storage-guard.js'

// The installer calls this from outside the service cgroup, with ingress already closed.
export async function stopPredecessor(dataRoot: string, configFile: string, userDataRoot?: string, userDataMount?: string): Promise<void> {
  const container = { runtime: '/usr/bin/podman', image: '', internalPort: 4180, gatewayPort: 3081 }
  const ownership = createHash('sha256').update(resolve(dataRoot)).digest('hex')
  const owned = new OwnedCommunityContainers(container, ownership)
  let captured: Awaited<ReturnType<typeof owned.captureLegacyProfileWriters>> = []
  try {
    const saved = FilePlatformDatabaseConfig.open(configFile, dataRoot)
    if (!saved.deploymentId || !saved.selection) throw Error('The predecessor database was not selected')
    const pool = platformDatabasePool(saved.connection)
    try {
      const client = await pool.connect()
      try {
        await client.query('BEGIN READ ONLY')
        await client.query('SET LOCAL statement_timeout=10000')
        const inspection = await inspectPlatformDatabaseSession(client, saved.security.registry.masterFingerprint, saved.deploymentId)
        if (!inspection.ok || inspection.schema === 'empty') throw Error('The predecessor database did not verify')
        const sql: PlatformSql = { query: async (text, values) => (await client.query(text, values && [...values])).rows }
        const refuseWrite = async () => {
          throw Error('The predecessor storage check is read-only')
        }
        const guard = new UserStorageGuard(
          dataRoot,
          {
            read: () => readUserStorageRecord(sql),
            createOwner: refuseWrite,
            saveBinding: refuseWrite,
          },
          userDataRoot,
          true,
          userDataMount,
        )
        await guard.initialize({ readOnly: true })
        const spaces = new FileCommunityUserSpaces(
          { dataRoot, container, ...(userDataRoot ? { userDataRoot } : {}), ...(userDataMount ? { userDataMount } : {}) },
          {
            getSpace: username => readCommunityUserSpace(sql, username),
          },
          guard,
        )
        const predecessor = new OwnedCommunityContainers(container, ownership, undefined, spaces.existingHome.bind(spaces))
        captured = await predecessor.captureLegacyProfileWriters()
      } finally {
        client.release(true)
      }
    } finally {
      await pool.end()
    }
  } catch {
    console.warn('Could not establish legacy member profile writer evidence before stopping the predecessor')
  }
  try {
    await owned.stopPredecessorMembers()
  } catch {
    console.warn('Could not stop every member before stopping the predecessor')
  }
  await execFileText('/usr/bin/systemctl', ['--user', 'stop', 'dsh-phalanx.service'], {
    env: containerClientEnvironment(),
    timeout: 60_000,
  })
  await owned.recoverLegacyProfileWriters(captured)
}
