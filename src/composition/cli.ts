import { createCommunityApplication } from './community-application.js'
import { loadCommunityConfig } from '../adapters/community-env-config.js'
import { createBootstrapLink } from '../adapters/community-bootstrap.js'
import { parseCommunityCommand } from '../inbound/community-command.js'
import { createCommunityStorageMigration } from './community-storage-migration.js'

async function main(): Promise<void> {
  const command = parseCommunityCommand(process.argv.slice(2))
  if (command.kind === 'bootstrap-link') {
    console.log(createBootstrapLink(command.dataRoot, command.origin, command.renew))
    return
  }
  const config = loadCommunityConfig()
  if (command.kind === 'migrate-user-storage') {
    console.log(JSON.stringify(await createCommunityStorageMigration(config.runtime).migrate(command.targetRoot, command.mount)))
    return
  }
  const application = createCommunityApplication(config)
  const origin = await application.start()
  console.log(`dsh-phalanx listening at ${origin}`)

  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopping ??= application.stop()
    return stopping
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void stop().then(() => {
        // Tenant-facing streams and keep-alive sockets are intentionally not
        // awaited by stop(); exit explicitly so a dangling connection cannot
        // hold the event loop (and a service-manager restart) open.
        process.exit(0)
      }).catch(error => {
        console.error(error instanceof Error ? error.message : 'dsh-phalanx shutdown failed')
        process.exit(1)
      })
    })
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'dsh-phalanx failed to start')
  // A failure after the listeners opened would otherwise leave a process that
  // answers 503 forever; exiting lets the service manager retry from scratch.
  process.exit(1)
})
