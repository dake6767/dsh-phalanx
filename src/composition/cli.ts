import { createCommunityApplication } from './community-application.js'
import { loadCommunityConfig } from '../adapters/community-env-config.js'

async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error('Usage: dsh-phalanx (configured through environment variables)')
  const application = createCommunityApplication(loadCommunityConfig())
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
