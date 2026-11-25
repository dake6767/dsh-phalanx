import { afterAll } from 'vitest'
import { closePostgresControlWorker, dropCreatedDatabases } from './postgres.js'

// Persistent fixture control uses a bounded worker thread; drop created DBs and release its client.
afterAll(async () => {
  try {
    dropCreatedDatabases()
  } finally {
    await closePostgresControlWorker()
  }
}, 60_000)
