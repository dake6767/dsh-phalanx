// Explicit installed milestone probe; excluded from the regular test inventories.
import { it } from 'vitest'
import { runInstalledBusiness } from './support/installed-business-scenario.js'

it('uses one fresh installed platform for model, plugin, MCP, execution and member entry before physical scanning', () => runInstalledBusiness())
