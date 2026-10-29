// Explicit installed data-root acceptance; run once per native architecture after its full Linux batch.
import { it } from 'vitest'
import { runInstalledBusiness } from './support/installed-business-scenario.js'

it('rebuilds every populated projection and preserves all five member capabilities before physical secret scanning', () => runInstalledBusiness(true), 1800000)
