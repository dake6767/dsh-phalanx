import { initializeBuiltinDatabase, waitForPlatformDatabase, writeBuiltinDatabasePassword } from '../adapters/builtin-database-setup.js'
import { createBootstrapLink } from '../adapters/community-bootstrap.js'
import { loadCommunityConfig } from '../adapters/community-env-config.js'
import { sendSystemControl } from '../adapters/community-system-update.js'
import {
  checkDatabaseSwitch,
  finalizeManagedDatabaseSwitch,
  recoverManagedDatabaseSwitch,
  switchPlatformDatabase,
} from '../adapters/platform-database-switch.js'
import { pluginBudgetRows, registeredSchemaVersions, savedDownloadSources } from '../adapters/platform-facts.js'
import { platformKeyFingerprint, resetPlatformKey, rotatePlatformKey } from '../adapters/platform-key-operations.js'
import { PlatformDatabaseError } from '../domain/platform-database.js'
import { parseCommunityCommand } from '../inbound/community-command.js'
import { createCommunityStorageMigration } from './community-storage-migration.js'
import { createSupervisedCommunityApplication } from './community-supervised-application.js'

async function main(): Promise<void> {
  const command = parseCommunityCommand(process.argv.slice(2))
  if (command.kind === 'help') {
    console.log(command.text)
    return
  }
  if (command.kind === 'database-switch-rollback' || command.kind === 'database-switch-finalize') {
    console.log(
      JSON.stringify(
        await (command.kind === 'database-switch-rollback' ? recoverManagedDatabaseSwitch : finalizeManagedDatabaseSwitch)(
          command.configFile,
          command.dataRoot,
          command.maintenanceFile,
          command.managedOperation,
        ),
      ),
    )
    return
  }
  if (command.kind === 'database-switch-check') {
    console.log(JSON.stringify(await checkDatabaseSwitch(command.configFile, command.dataRoot, command.target, command.connectionFile)))
    return
  }
  if (command.kind === 'database-switch') {
    console.log(
      JSON.stringify(
        await switchPlatformDatabase(
          command.configFile,
          command.dataRoot,
          command.maintenanceFile,
          command.target,
          command.connectionFile,
          command.managedOperation,
        ),
      ),
    )
    return
  }
  if (command.kind === 'managed-operation') {
    console.log(
      JSON.stringify(
        await sendSystemControl('/run/dsh-phalanx-updater/control.sock', {
          action: command.action,
          ...(command.action === 'master-key-reset' ? { confirmation: command.confirmation } : {}),
          ...(command.action === 'database-switch' ? { target: command.target } : {}),
        }),
      ),
    )
    return
  }
  if (command.kind === 'platform-facts') {
    // Exit 2 means the database could not answer; the caller falls back to its local choice and says so.
    try {
      const value =
        command.fact === 'download-sources'
          ? { selection: (await savedDownloadSources(command.configFile, command.dataRoot)) ?? null }
          : command.fact === 'schemas'
            ? { schemas: await registeredSchemaVersions(command.configFile, command.dataRoot) }
            : { schema: 1, plugins: await pluginBudgetRows(command.configFile, command.dataRoot) }
      console.log(JSON.stringify(value))
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Platform facts are unavailable')
      process.exitCode = error instanceof PlatformDatabaseError && error.code === 'unavailable' ? 2 : 1
    }
    return
  }
  if (command.kind === 'master-key-fingerprint') {
    console.log(JSON.stringify(platformKeyFingerprint(command.configFile, command.dataRoot)))
    return
  }
  if (command.kind === 'master-key-reset') {
    console.log(
      JSON.stringify(
        await resetPlatformKey(
          command.configFile,
          command.dataRoot,
          command.maintenanceFile,
          command.recoveryFile,
          command.confirmation,
          command.managedOperation,
        ),
      ),
    )
    return
  }
  if (command.kind === 'master-key-rotate') {
    console.log(JSON.stringify(await rotatePlatformKey(command.configFile, command.dataRoot, command.maintenanceFile, command.managedOperation)))
    return
  }
  if (command.kind === 'bootstrap-link') {
    console.log(await createBootstrapLink(command.dataRoot, command.origin, command.renew, process.env.DSH_PHALANX_DATABASE_CONFIG_FILE))
    return
  }
  if (command.kind === 'database-initialize') {
    console.log(JSON.stringify(initializeBuiltinDatabase(command.configFile, command.masterKeyPath, command.dataRoot, command.port)))
    return
  }
  if (command.kind === 'database-password-file') {
    writeBuiltinDatabasePassword(command.configFile, command.dataRoot, command.output, command.maintenanceFile)
    return
  }
  if (command.kind === 'database-wait') {
    console.log(JSON.stringify(await waitForPlatformDatabase(command.configFile, command.dataRoot, command.maintenanceFile)))
    return
  }
  const config = loadCommunityConfig()
  if (command.kind === 'migrate-user-storage') {
    const migration = createCommunityStorageMigration(config)
    console.log(
      JSON.stringify(await (command.rollback ? migration.rollback(command.targetRoot, command.mount) : migration.migrate(command.targetRoot, command.mount))),
    )
    return
  }
  const application = createSupervisedCommunityApplication(config)
  const origin = await application.start()
  console.log(`dsh-phalanx listening at ${origin}`)

  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopping ??= application.stop()
    return stopping
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void stop()
        .then(() => {
          // Tenant-facing streams and keep-alive sockets are intentionally not
          // awaited by stop(); exit explicitly so a dangling connection cannot
          // hold the event loop (and a service-manager restart) open.
          process.exit(0)
        })
        .catch(error => {
          console.error(error instanceof Error ? error.message : 'dsh-phalanx shutdown failed')
          process.exit(1)
        })
    })
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'dsh-phalanx failed to start')
  // Fatal entry/configuration loading failures require a fresh service process.
  process.exit(1)
})
