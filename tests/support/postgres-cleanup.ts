import { afterAll } from 'vitest'
import { dropCreatedDatabases } from './postgres.js'

// Synchronous fixture control uses a bounded subprocess; keep the same cleanup deadline.
afterAll(() => {
  dropCreatedDatabases()
}, 60_000)
