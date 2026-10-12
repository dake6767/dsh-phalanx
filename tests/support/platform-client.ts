import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { platformPluginClient as sourceClient } from '../../src/dsh/community-platform-client.js'

const installed = process.env.DSH_PHALANX_INSTALL_ROOT
// Vite and tsc format embedded function.toString() bodies differently. Fault
// injection must match the delivered client, evaluated by its bundled Node.
export const platformPluginClient = installed === undefined ? sourceClient : execFileSync(
  join(installed, 'node/bin/node'), ['--input-type=module', '-e',
    `const {platformPluginClient}=await import(${JSON.stringify(pathToFileURL(join(installed, 'dist/dsh/community-platform-client.js')).href)});process.stdout.write(platformPluginClient)`],
  { encoding: 'utf8' },
)
