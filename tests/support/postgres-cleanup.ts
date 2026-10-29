import { afterAll } from 'vitest'
import { dropCreatedDatabases } from './postgres.js'

// Each drop crosses the VM and container boundary; under parallel files it can take several seconds.
afterAll(() => {
  dropCreatedDatabases()
}, 60_000)
