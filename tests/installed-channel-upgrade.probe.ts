// Explicit installed-host acceptance; controlled metadata, fictional accounts, no release gate.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { request, type APIRequestContext } from 'playwright'
import { expect, it } from 'vitest'
import { execFileText } from '../src/adapters/runtime-command.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'
import { installedReleaseFixture } from './support/installed-release-fixture.js'
import { installedShellArgument } from './support/installed-storage-layout.js'
import { InstalledMaintenanceObserver } from './support/installed-maintenance-observer.js'

it('converts an installed candidate to the same-version formal channel with accounts and member files retained', async () => {
  const bundle = process.env.DSH_PHALANX_FORMAL_UPGRADE_BUNDLE,
    installer = process.env.DSH_PHALANX_FORMAL_UPGRADE_INSTALLER,
    candidate = process.env.DSH_PHALANX_CANDIDATE_SHA,
    tag = process.env.DSH_PHALANX_CANDIDATE_TAG,
    evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || !bundle || !installer || !evidence || !candidate || !tag || !/^run-[1-9]\d*$/u.test(tag))
    throw Error('Requires an owned root installation of the exact candidate and its verified bundle')
  const remote = (command: string, timeout = 120000) => execFileText('bash', ['-c', `cd / && ${command}`], { timeout, maxBuffer: 4 * 1024 * 1024 })
  const receipt = () => readFile('/etc/dsh-phalanx/install-state.json', 'utf8').then(JSON.parse)
  const originalReceipt = await receipt()
  expect(originalReceipt).toMatchObject({ version: tag, commit: candidate, channel: { kind: 'candidate' } })
  const origin = 'http://127.0.0.1:18080'
  let release: Awaited<ReturnType<typeof installedReleaseFixture>> | undefined,
    admin: APIRequestContext | undefined,
    member: APIRequestContext | undefined,
    maintenance: InstalledMaintenanceObserver | undefined
  const get = async (path: string) => {
    const response = await admin!.get('/admin/api/' + path)
    expect(response.status()).toBe(200)
    return response.json()
  }
  const post = (path: string, data: object) => admin!.post('/admin/api/' + path, { headers: { origin }, data })
  const login = async (client: APIRequestContext, username: string) =>
    expect((await client.post('/login', { headers: { origin }, form: { username, password: 'channel-fixture-password' }, maxRedirects: 0 })).status()).toBe(303)
  let sources: { preset: string; overrides: Record<string, string> } | undefined,
    sourcesRestored = false,
    passed = false,
    operation: { id: string; phase: string } | undefined
  const failures: unknown[] = []
  try {
    if (process.env.DSH_PHALANX_MAINTENANCE_DATABASE_FIXTURE)
      maintenance = await InstalledMaintenanceObserver.open(process.env.DSH_PHALANX_MAINTENANCE_DATABASE_FIXTURE)
    release = await installedReleaseFixture(bundle, candidate, tag, 0, undefined, '127.0.0.1')
    admin = await request.newContext({ baseURL: origin })
    member = await request.newContext({ baseURL: origin })
    const credential = (await readFile('/var/lib/dsh-phalanx/data/bootstrap-credential', 'utf8')).trim().split(/\s/u)[0]!
    expect(
      (
        await admin.post('/bootstrap', {
          headers: { origin },
          form: { credential, action: 'database-select', ...(maintenance?.bootstrap() ?? { databaseKind: 'builtin' }) },
        })
      ).status(),
    ).toBe(200)
    expect(
      (
        await admin.post('/bootstrap', {
          headers: { origin },
          form: { credential, username: 'channel-admin', password: 'channel-fixture-password' },
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(303)
    expect((await post('accounts', { username: 'channel-member', password: 'channel-fixture-password', email: '' })).status()).toBe(201)
    await login(member, 'channel-member')
    const accounts = await get('accounts')
    const user = 'runuser -u dsh-phalanx --',
      file = '/var/lib/dsh-phalanx/data.durable/users/channel-member/home/channel-owned.txt'
    await remote(`${user} mkdir -p ${installedShellArgument(file.slice(0, file.lastIndexOf('/')))}`)
    await remote(`${user} sh -c ${installedShellArgument(`printf '%s' CHANNEL_MEMBER_DATA > ${installedShellArgument(file)}`)}`)
    const memberBefore = await remote(`sha256sum ${installedShellArgument(file)} && stat -c '%s:%Y:%y' ${installedShellArgument(file)}`)
    const manifestBefore = await readFile('/etc/dsh-phalanx/installed-manifest.json')
    const selection = await get('download-sources')
    sources = { preset: selection.preset, overrides: selection.overrides ?? {} }
    expect(
      (
        await post('download-sources', { preset: sources!.preset, overrides: { ...sources!.overrides, githubAssets: `http://127.0.0.1:${release.port}/` } })
      ).status(),
    ).toBe(200)
    const cli = JSON.parse(await remote(`bash ${installedShellArgument(installer)} --upgrade check --output json`))
    const checked = await post('system-update', { action: 'check' })
    expect(checked.status()).toBe(200)
    const web = (await checked.json()).check
    for (const result of [cli.check, web])
      expect(result).toMatchObject({
        status: 'available',
        outcomeCode: 'update.channel-switch',
        version: 'v' + release.manifest.targetVersion,
        manifestSha256: release.manifestSha256,
      })
    expect(await receipt()).toEqual(originalReceipt)
    expect((await post('system-update', { action: 'prepare', version: web.version, manifestSha256: web.manifestSha256 })).status()).toBe(200)
    await expect.poll(async () => (await get('system-update')).operation?.phase, { timeout: 900000 }).toBe('prepared')
    operation = (await get('system-update')).operation
    expect(await receipt()).toEqual(originalReceipt)
    expect((await post('download-sources', sources!)).status()).toBe(200)
    sourcesRestored = true
    await maintenance?.arm(operation!.id)
    expect((await post('system-update', { action: 'apply', operation: operation!.id, confirmed: true })).status()).toBe(200)
    await maintenance?.observe()
    await expect
      .poll(
        async () => {
          try {
            await login(admin!, 'channel-admin')
            return (await get('system-update?operation=' + operation!.id)).operation?.phase
          } catch {
            return 'unavailable'
          }
        },
        { timeout: 900000 },
      )
      .toBe('succeeded')
    await expect.poll(async () => (await get('system-update?operation=' + operation!.id)).operation?.cleanup?.status, { timeout: 120000 }).toBe('succeeded')
    await login(admin!, 'channel-admin')
    await login(member, 'channel-member')
    expect(await get('accounts')).toEqual(accounts)
    expect(await remote(`sha256sum ${installedShellArgument(file)} && stat -c '%s:%Y:%y' ${installedShellArgument(file)}`)).toBe(memberBefore)
    expect(await readFile('/etc/dsh-phalanx/installed-manifest.json')).toEqual(manifestBefore)
    expect(await receipt()).toMatchObject({
      version: 'v' + release.manifest.targetVersion,
      commit: candidate,
      channel: { kind: 'formal', baseUrl: 'https://github.com/dake6767/dsh-phalanx/releases' },
    })
    expect(release.requests.some(url => url.endsWith('.oci.tar'))).toBe(false)
    passed = true
  } catch (error) {
    failures.push(error)
  }
  let cleanupPassed = false
  try {
    await cleanupOwned(
      async () => maintenance?.close(),
      async () => {
        if (sources && !sourcesRestored) expect((await post('download-sources', sources)).status()).toBe(200)
      },
      async () => admin?.dispose(),
      async () => member?.dispose(),
      async () => release?.close(),
    )
    cleanupPassed = true
  } catch (error) {
    failures.push(error)
  }
  try {
    await writeFile(
      join(evidence, 'installed-channel-upgrade-result.json'),
      JSON.stringify({
        passed: passed && cleanupPassed,
        cleanupPassed,
        candidate,
        tag,
        targetVersion: release?.manifest.targetVersion,
        operation: operation?.id,
        controlledMetadata: true,
        maintenance: maintenance ? { samples: maintenance.samples, externalFixture: true } : undefined,
        requests: release?.requests ?? [],
      }) + '\n',
    )
  } catch (error) {
    failures.push(error)
  }
  if (failures.length) throw new AggregateError(failures, 'Installed channel conversion failed')
}, 2400000)
