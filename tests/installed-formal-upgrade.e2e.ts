// Validation: T2 formal upgrade job; real credentials: none; formal previous release installed by the workflow, fixture models only. Never selected by the regular T2 batch.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { execFileText } from '../src/adapters/runtime-command.js'
import type { CommunityAccountView } from '../src/domain/admin-contract.js'
import { newValidationContext } from './fixtures/browser-evidence.js'
import { runCommunityTerminal, selectCommunityWorkspace, signInCommunity } from './fixtures/community-native-browser.js'
import { runInstalledUpgrade } from './support/installed-upgrade-scenario.js'
import { installedExternalDatabaseFixture } from './support/installed-maintenance-observer.js'
import { installedMemberHome, installedShellArgument, installedUserDataRoot } from './support/installed-storage-layout.js'
import { instanceWorkspacePath } from './support/real-dsh-runtime.js'

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
  const baseline = JSON.parse(await remote('cat /etc/dsh-phalanx/install-state.json')) as { version: string }
  const globalCommandAdded = baseline.version === 'v0.1.33'
  if (globalCommandAdded) await remote('test ! -e /usr/local/bin/dsh-phalanx && test ! -L /usr/local/bin/dsh-phalanx')
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
  const origin = 'http://127.0.0.1:18080'
  const { memberStorageKey } = await runInstalledUpgrade({
    origin,
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
  const deployment = JSON.parse(await remote('sudo -n dsh-phalanx status --language en --output json'))
  expect(deployment).toMatchObject({ state: 'running' })
  const users = await installedUserDataRoot(remote)
  const workspace = instanceWorkspacePath('', true)
  const username = 'upgrade-space-probe'
  const password = 'fictional-upgrade-space-password'
  const browser = await chromium.launch({ headless: true })
  try {
    const admin = await newValidationContext(browser, { locale: 'en' })
    await signInCommunity(await admin.newPage(), origin, 'admin', 'password', true)
    const post = (path: string, data: object) => admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
    const create = async () => {
      const created = await post('accounts', { username, password, email: '' })
      expect(created.status()).toBe(201)
      const { spaceId } = (await created.json()) as CommunityAccountView
      expect(spaceId).toMatch(/^[a-f0-9]{32}$/u)
      return spaceId
    }
    const enter = async (spaceId: string, marker: string, command: string) => {
      const context = await newValidationContext(browser, { locale: 'en' })
      try {
        const page = await context.newPage()
        await signInCommunity(page, origin, username, password)
        expect(page.url()).toBe(`${origin}/app/${spaceId}/`)
        await selectCommunityWorkspace(context, page, origin, workspace, true)
        await runCommunityTerminal(page, command, marker)
      } finally {
        await context.close()
      }
    }
    const file = (spaceId: string) => installedShellArgument(`${users}/_spaces/${spaceId}/home/Documents/deepseek-harness/default-workspace/upgrade-space.txt`)
    const first = await create()
    await enter(first, 'ORIGINAL_SPACE_READY', "printf original > upgrade-space.txt; printf 'ORIGINAL_%s' 'SPACE_READY'")
    expect(await remote(`sudo -n cat ${file(first)}`)).toBe('original')
    expect((await post(`accounts/${username}/actions`, { action: 'delete' })).status()).toBe(200)
    const replacement = await create()
    expect(replacement).not.toBe(first)
    await enter(
      replacement,
      'REPLACEMENT_SPACE_READY',
      "test ! -e upgrade-space.txt && printf replacement > upgrade-space.txt && printf 'REPLACEMENT_%s' 'SPACE_READY'",
    )
    expect(await remote(`sudo -n cat ${file(replacement)}`)).toBe('replacement')
    expect(await remote(`sudo -n cat ${file(first)}`)).toBe('original')

    const serviceUser = 'sudo -n -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx)'
    const carriers = async () => (await remote(`${serviceUser} podman ps --filter label=dsh-phalanx.community=1 --format '{{.ID}}'`)).trim()
    expect(await carriers()).toMatch(/^[a-f0-9]+/u)
    const stopped = JSON.parse(await remote('sudo -n dsh-phalanx stop --yes --language en --output json', 300_000))
    expect(stopped).toMatchObject({ status: 'succeeded', state: 'stopped' })
    const service = await remote(`${serviceUser} systemctl --user is-active dsh-phalanx.service`, 120_000, [0, 3])
    expect(service.trim()).toBe('inactive')
    expect(await carriers()).toBe('')
    const restarted = JSON.parse(await remote('sudo -n dsh-phalanx start --language en --output json', 300_000))
    expect(restarted).toMatchObject({ status: 'succeeded', state: 'running' })
    await expect.poll(async () => (await fetch(`${origin}/readyz`)).status, { timeout: 90_000 }).toBe(200)
    const retained = await newValidationContext(browser, { locale: 'en' })
    const retainedMember = await retained.newPage()
    await signInCommunity(retainedMember, origin, 'member', 'password')
    await selectCommunityWorkspace(retained, retainedMember, origin, workspace, true)
    await runCommunityTerminal(retainedMember, 'cat "$HOME/upgrade-owned.txt"', 'MEMBER_DATA_PRESERVED')
    expect(await remote('sudo -n cat ' + installedShellArgument((await installedMemberHome(remote, memberStorageKey)) + '/upgrade-owned.txt'))).toBe(
      'MEMBER_DATA_PRESERVED',
    )
  } finally {
    await browser.close()
  }
  const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  if (evidence) {
    await writeFile(
      join(evidence, 'formal-upgrade-deployment.json'),
      JSON.stringify({
        candidate,
        baselineVersion: baseline.version,
        globalCommandAdded,
        globalDeploymentStatus: deployment.state,
        deploymentRestarted: true,
        newSpaceDirectory: true,
        sameNameIsolated: true,
      }) + '\n',
      { mode: 0o600 },
    )
  }
}, 5400000)
