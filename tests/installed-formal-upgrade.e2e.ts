// Validation: T2 formal upgrade job; real credentials: none; formal previous release installed by the workflow, fixture models only. Never selected by the regular T2 batch.
import { expect, it } from 'vitest'
import { execFileText } from '../src/adapters/runtime-command.js'
import { runInstalledUpgrade } from './support/installed-upgrade-scenario.js'
import { installedExternalDatabaseFixture } from './support/installed-maintenance-observer.js'

it('upgrades the installed formal previous release to this build and preserves administrator and member data', async () => {
  const bundle = process.env.DSH_PHALANX_FORMAL_UPGRADE_BUNDLE,
    installer = process.env.DSH_PHALANX_FORMAL_UPGRADE_INSTALLER
  const candidate = process.env.DSH_PHALANX_CANDIDATE_SHA,
    tag = process.env.DSH_PHALANX_CANDIDATE_TAG
  if (
    process.platform !== 'linux' ||
    process.getuid?.() !== 0 ||
    !bundle ||
    !installer ||
    !candidate ||
    !tag ||
    !/^run-[1-9]\d*$/u.test(tag) ||
    ![bundle, installer].every(path => /^\/[a-zA-Z0-9/_.-]+$/u.test(path))
  ) {
    throw Error('Requires root on a disposable runner with the formal previous release installed and this build as a verified bundle')
  }
  // The runner is the installed host; commands run directly instead of over SSH.
  const remote = async (command: string, timeout = 120000, acceptedExitCodes = [0]) =>
    await execFileText('bash', ['-c', `cd / && ${command}`], { timeout, maxBuffer: 4 * 1024 * 1024, acceptedExitCodes })
  expect((await remote('id -u')).trim()).toBe('0')
  const fixturePath = process.env.DSH_PHALANX_UPGRADE_DATABASE_FIXTURE,
    containerId = process.env.DSH_PHALANX_UPGRADE_DATABASE_CONTAINER
  if (Boolean(fixturePath) !== Boolean(containerId)) throw Error('External upgrade acceptance requires both its original fixture and container identity')
  let database: Parameters<typeof runInstalledUpgrade>[0]['database']
  if (fixturePath && containerId) {
    expect(containerId).toMatch(/^[a-f0-9]{64}$/u)
    const fixture = await installedExternalDatabaseFixture(fixturePath)
    const [container] = JSON.parse(await remote(`sudo podman container inspect ${containerId}`))
    expect(container.Id).toBe(containerId)
    expect(container.State.Running).toBe(true)
    expect(container.Config.Labels).toMatchObject({
      'dsh-phalanx.validation-source': candidate,
      'dsh-phalanx.upgrade-database-sha256': fixture.configurationSha256,
    })
    expect(container.HostConfig.PortBindings['5432/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: String(fixture.connection.port) }])
    database = { bootstrap: fixture.bootstrap, identity: { kind: 'external', configurationSha256: fixture.configurationSha256, containerId } }
  }
  await runInstalledUpgrade({
    origin: 'http://127.0.0.1:18080',
    address: '127.0.0.1',
    remote,
    bundle,
    installer,
    releaseBundle: bundle,
    candidate,
    tag,
    realReply: false,
    ...(database ? { database } : {}),
  })
}, 5400000)
