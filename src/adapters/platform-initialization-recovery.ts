import { FilePlatformDatabaseConfig } from './platform-database-config.js'
import { readExecutorFacts } from './platform-executor-facts.js'
import { PlatformDatabase } from './platform-database.js'
import { PlatformLock } from './platform-lock.js'
import { PostgresUserStorageFacts } from './postgres-user-storage-facts.js'
import { UserStorageGuard } from './user-storage-guard.js'
import { readPlatformDatabaseState } from './platform-database-inspection.js'

interface InitializationRecovery {
  readonly configFile: string
  readonly dataRoot: string
  readonly proof: { readonly initializationPending: boolean; readonly deploymentId: string; readonly fingerprint: string; readonly identity: unknown[] }
  readonly storage: { readonly userDataRoot?: string; readonly userDataMount?: string; readonly container: boolean }
}

/** Called only by the executor under its durable legacy-rejection proof and closed admission.
 * The generated program loads the installed source's database and storage owners.
 * It prepares the missing first-install storage identity without relaxing normal maintenance startup.
 */
export async function prepareInitializationRecovery(request: InitializationRecovery): Promise<{ prepared: boolean }> {
  if (request.proof.initializationPending !== true) throw Error('Initialization recovery requires its original rejection proof')
  const lock = new PlatformLock(request.dataRoot)
  let database: PlatformDatabase | undefined
  const verify = async () => {
    const facts = await readExecutorFacts(request.configFile, request.dataRoot, 'rotation', [])
    if (
      !('initializationPending' in facts) ||
      facts.deploymentId !== request.proof.deploymentId ||
      facts.fingerprint !== request.proof.fingerprint ||
      JSON.stringify(facts.identity) !== JSON.stringify(request.proof.identity)
    )
      throw Error('Initialization recovery protected identity changed')
  }
  try {
    await verify()
    const saved = FilePlatformDatabaseConfig.open(request.configFile, request.dataRoot)
    if (!saved.selection) return { prepared: false }
    // A retry may find schema committed before storage preparation. Never adopt an installed account database.
    database = new PlatformDatabase(saved.connection, saved.security)
    let lost = false
    await database.claimDeployment(request.proof.deploymentId, () => {
      lost = true
    })
    if ((await readPlatformDatabaseState(saved.connection)).complete) throw Error('Initialization recovery cannot prepare an established deployment')
    await database.initialize()
    await new UserStorageGuard(
      request.dataRoot,
      new PostgresUserStorageFacts(database),
      request.storage.userDataRoot,
      request.storage.container,
      request.storage.userDataMount,
    ).initialize()
    await verify()
    if (lost) throw Error('Initialization recovery lost deployment ownership')
    return { prepared: true }
  } finally {
    try {
      await database?.close()
    } finally {
      lock.close()
    }
  }
}
