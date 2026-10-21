import { expect, it } from 'vitest'
import { startPlatformCli } from './support/platform-cli.js'
it('reports a bounded redacted diagnostic when a CLI exits before readiness', async () => {
  await expect(startPlatformCli(process.execPath, ['-e', 'console.error("fixture startup failed " + process.env.FIXTURE_SECRET + " ?token=private-query");process.exit(1)'], { FIXTURE_SECRET: 'private-fixture-secret' })).rejects.toThrow('fixture startup failed [redacted] ?token=[redacted]')
})
