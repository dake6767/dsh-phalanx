// Validation: T4 only; real credentials: required (provider keys and member WeCom authorization). Never selected by T2.
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir, lstat, chmod, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection, instanceWorkspacePath, defaultWorkspacePath } from './support/real-dsh-runtime.js'
import { signInCommunity, selectCommunityWorkspace, runCommunityTerminal, startCommunitySession, sendCommunityPrompt } from './fixtures/community-native-browser.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { suiteCatalog, suiteRuntimeDependencyDefinition, type SuiteCatalogEntry } from '../src/domain/suite-catalog.js'
import { legacySuiteCatalogFixture, type SuiteCatalogServerFixture } from './fixtures/suite-catalog-server.js'
import { onlineCatalogEntries } from './fixtures/suite-catalog-online.js'
import type { CommunityConfig } from '../src/domain/community-config.js'
import type { createCommunityApplication } from '../src/composition/community-application.js'
import type { CommunitySuiteCatalogView, CommunityRuntimeDependencyView, CommunitySkillImportPreview, CommunitySkillView, CommunitySkillGroupView, CommunityDownloadSourcesView } from '../src/domain/admin-contract.js'

const phase = process.env.DSH_PHALANX_SUITE_PHASE ?? 'prepare'
const required = (name: string) => { const value = process.env[name]; if (!value) throw Error(`Missing private validation input: ${name}`); return value }
interface PrivateInputs { modelApiKey?: string; minimaxApiKey?: string; larkAppId?: string; larkAppSecret?: string }

function isLarkBotInfo(output: string): boolean {
  try {
    const response = JSON.parse(output) as { ok?: unknown; identity?: unknown; data?: { open_id?: unknown } }
    return response.ok === true && response.identity === 'bot' && typeof response.data?.open_id === 'string' && response.data.open_id.length > 0
  } catch { return false }
}

/** Phases preserve one owned data root between invocations; cleanup is explicit after all acceptance and diagnostics. */
it(`validates the installed suite catalog on the real host: ${phase}`, async () => {
  expect(['prepare', 'rollback', 'smoke', 'wecom', 'shared', 'architecture', 'cleanup']).toContain(phase)
  expect(process.platform).toBe('linux')
  const installed = required('DSH_PHALANX_INSTALL_ROOT'), root = resolve(required('DSH_PHALANX_SUITE_DATA_ROOT'))
  expect(root.startsWith('/var/tmp/dsh-018-13-')).toBe(true)
  const resuming = process.env.DSH_PHALANX_SUITE_RESUME === '1'
  const inputs: PrivateInputs = process.env.DSH_PHALANX_SUITE_INPUT ? JSON.parse(await readFile(process.env.DSH_PHALANX_SUITE_INPUT, 'utf8')) : {}
  const secrets = Object.values(inputs).filter((value): value is string => typeof value === 'string' && value !== '')
  const evidence = resolve(required('DSH_PHALANX_E2E_EVIDENCE_DIR'))
  await mkdir(evidence, { recursive: true, mode: 0o700 })
  const safe = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value)
  const receipt = async (name: string, value: object) => writeFile(join(evidence, name + '.json'), safe(JSON.stringify(value, null, 2)) + '\n', { mode: 0o600 })
  await mkdir(root, { recursive: true, mode: 0o700 })
  const ownership = join(root, 'suite-acceptance-owner.json')
  if (phase === 'prepare' && !resuming) {
    expect((await readdir(root)).length, 'Preparation requires a fresh owned root').toBe(0)
    await writeFile(ownership, JSON.stringify({ purpose: '0.1.18-suite-acceptance', uid: process.getuid!(), installed, candidate: required('DSH_PHALANX_CANDIDATE_SHA') }), { mode: 0o600 })
  }
  const owner = JSON.parse(await readFile(ownership, 'utf8'))
  expect(owner).toMatchObject({ purpose: '0.1.18-suite-acceptance', uid: process.getuid!(), installed, candidate: required('DSH_PHALANX_CANDIDATE_SHA') })
  assertPinnedDshRevision(runtimeSettings)
  expect(runtimeSettings.containerImage).toBeTruthy()
  const runtime = runtimeSection(root, 'https://api.deepseek.com', runtimeSettings)
  const config: CommunityConfig = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'suite-real-acceptance-session-secret', runtime,
    ...(inputs.modelApiKey ? { modelGateway: { upstreamApiKey: inputs.modelApiKey } } : {}) }
  if (phase === 'cleanup') {
    await new CommunityRuntimeDriver(runtime).rebuild()
    const artifacts = new FileSkillArtifacts(join(root, 'skills', 'artifacts'), [])
    await new FileSkillDistribution(join(root, 'skills', 'members'), artifacts).synchronize([])
    await artifacts.collect([])
    await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([])
    const writable = async (path: string): Promise<void> => { const info = await lstat(path); if (info.isSymbolicLink()) return; if (info.isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }
    await writable(root); await rm(root, { recursive: true })
    await receipt('cleanup', { passed: true, rootRemoved: true }); return
  }
  let app = candidateApplication(config, 120000)
  let catalogFixture: SuiteCatalogServerFixture | undefined
  if (phase === 'shared' || phase === 'architecture') {
    // The fixture uses the installed modules' composition option, while production suite phases use the public CLI.
    const build = JSON.parse(await readFile(join(installed, 'build-info.json'), 'utf8'))
    expect(build.commit).toBe(required('DSH_PHALANX_CANDIDATE_SHA'))
    const compiled = await import(pathToFileURL(join(installed, 'dist/composition/community-application.js')).href) as { createCommunityApplication: typeof createCommunityApplication }
    const text = { en: 'Shared dependency acceptance fixture', 'zh-CN': '共用依赖验收夹具' }
    const fixture: SuiteCatalogEntry = phase === 'architecture' ? { category: 'dependency', id: 'architecture-fixture', version: '1', title: { en: 'Architecture fixture', 'zh-CN': '架构夹具' }, description: text, source: text, items: [{ kind: 'runtime-dependency', name: 'architecture-fixture', prepareCommands: { amd64: 'exit 98' }, pathDirectories: ['bin'], commands: ['architecture-fixture'] }] } : { category: 'suite', id: 'shared-validation', version: '1', title: text, description: text, source: text, identity: text, dependencies: ['ffmpeg'], items: [] }
    // The signed fixture carries the dynamically built entry; the shared phase also needs the online FFmpeg document.
    const extra = phase === 'shared' ? onlineCatalogEntries.filter(row => row.id === 'ffmpeg') : []
    catalogFixture = await legacySuiteCatalogFixture([fixture], extra)
    app = compiled.createCommunityApplication({ ...config, downloadSources: catalogFixture.downloadSources }, { suiteCatalog: { address: catalogFixture.address, trustedKeys: catalogFixture.trustedKeys } })
  }
  const browser = await chromium.launch({ headless: true }), admin = await browser.newPage({ locale: 'en' })
  admin.setDefaultTimeout(60000)
  let stage = 'start', completed = false, cleanupFailed = false, origin = ''
  const setStage = async (value: string) => { stage = value; await receipt('stage', { phase, stage }); console.info('Suite acceptance phase:', stage) }
  const get = async <T>(path: string): Promise<T> => {
    const response = await admin.request.get(origin + '/admin/api/' + path)
    expect(response.status(), `GET ${path}`).toBe(200); return response.json()
  }
  const post = async <T>(path: string, data: unknown): Promise<T> => {
    const response = await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data, timeout: 180000 })
    expect(response.status(), `POST ${path}`).toBeLessThan(300); return response.json()
  }
  const installations = () => get<CommunitySuiteCatalogView>('suites')
  const dependencies = () => get<CommunityRuntimeDependencyView[]>('runtime-dependencies')
  const install = async (id: string, input: object = {}) => {
    await setStage('install-' + id)
    // Opening the gallery loads the signed document; the install action never fetches the catalog itself.
    await installations()
    await post('suites', { action: 'install', input: { id, requestId: randomUUID(), ...input } })
    await expect.poll(async () => (await installations()).installations.find(row => row.id === id)?.status, { timeout: 1800000, interval: 2000 }).toMatch(/^(installed|failed)$/u)
    expect((await installations()).installations.find(row => row.id === id)?.status).toBe('installed')
    await receipt('install-' + id, { passed: true, category: id, architecture: process.arch, downloadPreset: 'mainland' })
  }
  try {
    origin = await app.start()
    const bootstrap = readBootstrapCredential(root)
    const signed = await admin.request.post(origin + (bootstrap ? '/bootstrap' : '/login'), { headers: { origin }, maxRedirects: 0,
      form: { username: 'admin', password: 'password', ...(bootstrap ? { credential: bootstrap.credential } : {}) } })
    expect(signed.status()).toBe(303)
    if (phase === 'architecture') {
      expect(process.arch).toBe('arm64')
      expect((await installations()).entries.find(row => row.id === 'architecture-fixture')?.available).toBe(false)
      expect(await get('suites/preview?id=architecture-fixture')).toMatchObject({ available: false, reason: 'unavailable-architecture' })
      await admin.goto(origin + '/admin/suites?locale=en')
      const card = admin.locator('.plugin-library-card').filter({ hasText: 'Architecture fixture' })
      await card.getByText('Unavailable on this architecture', { exact: true }).waitFor()
      expect(await card.getByRole('button', { name: 'Install', exact: true }).isDisabled()).toBe(true)
      await receipt('architecture', { passed: true, architecture: 'arm64', installedModuleFixture: true, unavailableLabel: true, installationDisabled: true })
    } else if (phase === 'prepare') {
      await setStage('manual-feishu-baseline')
      const groups = await get<{ id: string; isDefault: boolean }[]>('groups'), group = groups.find(row => row.isDefault)!
      if (!resuming) {
      await post('accounts', { username: 'suite-member', password: 'password', email: '', groupId: group.id })
      const lark = suiteCatalog.find(row => row.id === 'lark')!
      const tool = lark.items.find(item => item.kind === 'runtime-dependency')!
      if (tool.kind !== 'runtime-dependency') throw Error('Missing pinned CLI definition')
      const definition = suiteRuntimeDependencyDefinition(tool, process.arch === 'arm64' ? 'arm64' : 'amd64')!
      await post('runtime-dependencies', { action: 'create', input: { ...definition, name: 'manual-feishu' } })
      await expect.poll(async () => (await dependencies()).find(row => row.name === 'manual-feishu')?.stage, { timeout: 900000, interval: 2000 }).toBe('ready')
      const skillItem = lark.items.find(item => item.kind === 'skill')!
      if (skillItem.kind !== 'skill') throw Error('Missing pinned skills')
      const preview = await post<CommunitySkillImportPreview>('skills/import/git', { source: `${skillItem.source.url}/tree/${skillItem.source.commit}/${skillItem.source.path}` })
      await post('skills/import/confirm', { token: preview.token, names: skillItem.names, replacements: [], packs: [] })
      if (inputs.larkAppId && inputs.larkAppSecret) {
        await post('skills/execution?name=lark-shared', { enabled: true, commands: [{ command: 'lark-cli', blocked: ['config', 'auth', 'profile', 'update'] }], variables: [{ name: 'LARKSUITE_CLI_APP_ID', value: inputs.larkAppId, secret: true }, { name: 'LARKSUITE_CLI_APP_SECRET', value: inputs.larkAppSecret, secret: true }], runtimeDependencies: ['manual-feishu'] })
        const trial = await post<{ exitCode: number; stdout: string }>('execution/trial', { owner: 'skill:lark-shared', line: 'lark-cli api GET /open-apis/bot/v3/info --as bot' })
        expect(trial.exitCode).toBe(0); expect(isLarkBotInfo(trial.stdout)).toBe(true)
        await receipt('manual-feishu-bot', { passed: true, beforeCatalogTakeover: true, identity: 'team-bot', retainedDependencyName: 'manual-feishu' })
      }
      const grantPath = 'groups/' + group.id + '/skills', grant = await get<CommunitySkillGroupView>(grantPath)
      await post(grantPath, { action: 'save', names: ['lark-shared'], revision: grant.revision, confirmed: true })
      // Publication and self-selection are captured through their HTTP boundaries, rather than inferred from storage.
      await admin.goto(origin + '/admin/skills?locale=en')
      await admin.getByRole('button', { name: 'View skill lark-shared', exact: true }).click()
      await admin.getByRole('tab', { name: 'Publication', exact: true }).click()
      await admin.getByRole('button', { name: 'Publish to Platform App Center', exact: true }).click()
      await admin.getByRole('button', { name: 'Confirm', exact: true }).click()
      await admin.getByRole('button', { name: 'Unpublish', exact: true }).waitFor()
      const selectableGroups = await post<{ id: string; name: string }[]>('groups', { action: 'create', name: 'Suite selection only' })
      const selectedGroup = selectableGroups.find(row => row.name === 'Suite selection only')!
      await post('accounts', { username: 'suite-selector', password: 'password', email: '', groupId: selectedGroup.id })
      } else expect(JSON.parse(await readFile(join(evidence, 'manual-baseline.json'), 'utf8'))).toMatchObject({ passed: true, candidate: required('DSH_PHALANX_CANDIDATE_SHA') })
      const selector = await browser.newContext({ locale: 'en' })
      expect((await selector.request.post(origin + '/login', { headers: { origin }, maxRedirects: 0, form: { username: 'suite-selector', password: 'password' } })).status()).toBe(303)
      if (!resuming) expect((await selector.request.post(origin + '/market/api/skills', { headers: { origin }, data: { action: 'install', name: 'lark-shared' } })).status()).toBe(200)
      const selected = async () => (await (await selector.request.get(origin + '/market/api/skills')).json()) as { skills: { name: string; selectedDirectly: boolean }[] }
      expect((await selected()).skills.find(row => row.name === 'lark-shared')?.selectedDirectly).toBe(true)
      if (!resuming) await receipt('manual-baseline', { passed: true, candidate: required('DSH_PHALANX_CANDIDATE_SHA') })
      const before = await get<CommunitySkillView[]>('skills')
      expect(before.find(row => row.name === 'lark-shared')?.published).toBe(true)
      for (const id of ['officecli', 'wecom', 'minimax', 'hyperframes', 'lark']) {
        const current = (await installations()).installations.find(row => row.id === id)
        if (resuming && current?.status === 'installed') { const expected = suiteCatalog.find(row => row.id === id)?.version; if (expected) expect(current.version).toBe(expected); continue }
        const credentials = id === 'minimax' && inputs.minimaxApiKey ? { MINIMAX_API_KEY: inputs.minimaxApiKey }
          : id === 'lark' && inputs.larkAppId && inputs.larkAppSecret ? { LARKSUITE_CLI_APP_ID: inputs.larkAppId, LARKSUITE_CLI_APP_SECRET: inputs.larkAppSecret } : {}
        const plan = await get<{ replacements?: readonly object[] }>('suites/preview?id=' + id)
        await install(id, { groups: [group.id], publish: true, credentials, ...(plan.replacements?.length ? { replace: plan.replacements } : {}) })
      }
      expect((await dependencies()).find(row => row.name === 'manual-feishu')?.source).toBe('suite-catalog')
      expect((await get<CommunitySkillView[]>('skills')).find(row => row.name === 'lark-shared')?.published).toBe(true)
      expect((await get<CommunitySkillGroupView>('groups/' + group.id + '/skills')).skills.find(row => row.name === 'lark-shared')?.granted).toBe(true)
      expect((await selected()).skills.find(row => row.name === 'lark-shared')?.selectedDirectly).toBe(true)
      await receipt('manual-takeover', { passed: true, libraryNamePreserved: true, publicationPreserved: true, directGrantPreserved: true, memberSelectionPreserved: true })
    } else if (phase === 'rollback') {
      await setStage('prepare-failure-rollback')
      const sources = await get<CommunityDownloadSourcesView>('download-sources')
      expect(sources.preset).toBe('mainland')
      const beforeFailure = { dependencies: (await dependencies()).map(row => [row.name, row.current?.id]), skills: (await get<CommunitySkillView[]>('skills')).map(row => row.name) }
      try {
        await post('download-sources', { preset: sources.preset, overrides: { ...sources.overrides, githubAssets: 'http://127.0.0.1:1/' } })
        await post('suites', { action: 'install', input: { id: 'pandoc', requestId: randomUUID() } })
        await expect.poll(async () => (await installations()).installations.find(row => row.id === 'pandoc')?.status, { timeout: 180000, interval: 1000 }).toBe('failed')
        expect({ dependencies: (await dependencies()).map(row => [row.name, row.current?.id]), skills: (await get<CommunitySkillView[]>('skills')).map(row => row.name) }).toEqual(beforeFailure)
      } finally { await post('download-sources', { preset: sources.preset, ...(sources.overrides ? { overrides: sources.overrides } : {}) }) }
      await install('pandoc')
      await receipt('failure-rollback', { passed: true, librariesUnchanged: true, retryPassedWithOriginalSource: true })
    } else if (phase === 'smoke' || phase === 'wecom') {
      expect(process.arch).toBe('x64'); expect(inputs.modelApiKey).toBeTruthy()
      const page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1100 } }); page.setDefaultTimeout(60000)
      await signInCommunity(page, origin, 'suite-member', 'password')
      await selectCommunityWorkspace(page.context(), page, origin, instanceWorkspacePath(defaultWorkspacePath(root, 'suite-member'), true), true)
      const workspace = defaultWorkspacePath(root, 'suite-member')
      const mountedWorkspace = instanceWorkspacePath(workspace, true)
      const container = async () => (await execFileText(runtimeSettings.containerRuntimeCli, ['ps', '--filter', 'label=dsh-phalanx.community-root=' + createHash('sha256').update(root).digest('hex'), '--filter', 'label=dsh-phalanx.user=suite-member', '--format', '{{.Names}}'])).trim()
      if (phase === 'wecom') {
        await setStage('wecom-member-authorization')
        await runCommunityTerminal(page, `wecom-cli auth init --noninteractive --no-browser --output-qrcode "${join(mountedWorkspace, 'wecom-authorization.png')}"`, 'wecom')
        const qrPath = join(workspace, 'wecom-authorization.png')
        await expect.poll(async () => { try { return (await readFile(qrPath)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) } catch { return false } }, { timeout: 60000, interval: 500 }).toBe(true)
        await writeFile(join(evidence, 'wecom-authorization.png'), await readFile(qrPath), { mode: 0o600 })
        await receipt('wecom-awaiting-member', { ready: true, screenshot: 'wecom-authorization.png' })
        console.info('Member authorization is ready; the private screenshot is available.')
        await expect.poll(async () => {
          try { return (await execFileText(runtimeSettings.containerRuntimeCli, ['exec', await container(), 'wecom-cli', 'auth', 'show', '--status'])).trim() } catch { return '' }
        }, { timeout: 600000, interval: 2000 }).toBe('authorized')
        const credentials = await lstat(join(root, 'users', 'suite-member', 'home', '.config', 'wecom', 'credentials.enc'))
        expect(credentials.isFile()).toBe(true); expect(credentials.size).toBeGreaterThan(0)
        expect(credentials.uid).toBe(process.getuid!()); expect(credentials.mode & 0o077).toBe(0)
        await receipt('wecom-authorized', { passed: true, memberOwnedIdentity: true, authenticatedCliCall: true, encryptedCredentialsInMemberHome: true, privatePermissions: true })
      } else {
        const tasks = [
          { id: 'officecli', file: 'officecli-version.txt', prompt: 'Run the platform officecli --version in bash and write its actual output to officecli-version.txt in the workspace. Do not install or update anything.', valid: (bytes: Buffer) => bytes.toString().includes('1.0.157') },
          { id: 'wecom', file: 'wecom-version.txt', prompt: 'Run the platform wecom-cli --version in bash and write its actual output to wecom-version.txt. Do not sign in yet, install or update anything.', valid: (bytes: Buffer) => bytes.toString().includes('1.3.4') },
          { id: 'minimax', file: 'suite-image.png', prompt: 'Use the supplied mmx CLI and its documented image options to generate one square image of a blue circle on white, saving the actual image as suite-image.png in this workspace. Preserve its native image encoding. The team key is already supplied by platform execution. Do not authenticate, install, update or print any credential.', valid: (bytes: Buffer) => bytes.length > 100 && (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) || bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') },
          { id: 'lark', file: 'suite-bot.json', prompt: 'Use the platform Feishu bot CLI to run lark-cli api GET /open-apis/bot/v3/info --as bot and save the actual JSON response to suite-bot.json. Do not send messages, change data, authenticate, install or print credentials.', valid: (bytes: Buffer) => isLarkBotInfo(bytes.toString()) },
          { id: 'hyperframes', file: 'suite-video.mp4', prompt: 'Use the supplied HyperFrames skills and CLI to create a simple two-second 320x180 animation of a moving red square and render suite-video.mp4 in this workspace. Use local HTML/CSS only, with no CDN, web fonts, voice, cloud services or offline ML engines. Chromium and FFmpeg are provided. Do not install/update the CLI, browser or skills.', valid: (bytes: Buffer) => bytes.length > 1024 && bytes.subarray(4, 8).toString() === 'ftyp' },
        ]
        const sample = process.env.DSH_PHALANX_SUITE_SAMPLE
        if (sample) expect(tasks.map(task => task.id)).toContain(sample)
        for (const task of tasks.filter(row => !sample || row.id === sample)) {
          await setStage('member-agent-' + task.id)
          await startCommunitySession(page)
          await page.getByRole('button', { name: /deepseek-chat/u }).waitFor({ timeout: 60000 })
          await sendCommunityPrompt(page, task.prompt)
          await expect.poll(async () => { try { return task.valid(await readFile(join(workspace, task.file))) } catch { return false } }, { timeout: 600000, interval: 2000 }).toBe(true)
          await expect.poll(() => page.getByRole('button', { name: 'Stop generating', exact: true }).count(), { timeout: 120000 }).toBe(0)
          let video: { width: number; height: number; durationSeconds: number } | undefined
          if (task.id === 'hyperframes') {
            const probe = JSON.parse(await execFileText(runtimeSettings.containerRuntimeCli, ['exec', await container(), 'ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', join(mountedWorkspace, task.file)])) as { streams: { codec_type: string; width: number; height: number }[]; format: { duration: string } }
            const stream = probe.streams.find(row => row.codec_type === 'video')!
            expect(stream?.width).toBeGreaterThan(0); expect(stream?.height).toBeGreaterThan(0)
            video = { width: stream.width, height: stream.height, durationSeconds: Number(probe.format.duration) }; expect(video.durationSeconds).toBeGreaterThan(0)
          }
          const environment = await execFileText(runtimeSettings.containerRuntimeCli, ['exec', await container(), 'env'])
          expect(secrets.some(secret => environment.includes(secret)), 'Platform credentials absent from the member environment').toBe(false)
          const scan = async (directory: string): Promise<boolean> => {
            for (const name of await readdir(directory)) { const path = join(directory, name), info = await lstat(path); if (info.isSymbolicLink()) continue; if (info.isDirectory()) { if (await scan(path)) return true } else if (info.isFile()) { const bytes = await readFile(path); if (secrets.some(secret => bytes.includes(Buffer.from(secret)))) return true } }
            return false
          }
          expect(await scan(join(root, 'users', 'suite-member')), 'Platform credentials absent from member-readable files').toBe(false)
          await receipt('member-' + task.id, { passed: true, newNativeSession: true, realProvider: true, outputSha256: createHash('sha256').update(await readFile(join(workspace, task.file))).digest('hex'), credentialAbsent: true, ...(video ? { video } : {}) })
        }
      }
    } else if (phase === 'shared') {
      const before = (await dependencies()).find(row => row.name === 'ffmpeg')!
      expect(before.current?.id).toBeTruthy()
      await install('shared-validation')
      expect((await dependencies()).filter(row => row.current?.commands.includes('ffmpeg'))).toHaveLength(1)
      await post('suites', { action: 'uninstall', id: 'hyperframes', input: { removeDependencies: ['chromium'] } })
      await expect.poll(async () => (await installations()).installations.some(row => row.id === 'hyperframes'), { timeout: 120000 }).toBe(false)
      expect((await dependencies()).find(row => row.name === 'ffmpeg')?.current?.id).toBe(before.current?.id)
      await post('suites', { action: 'uninstall', id: 'shared-validation', input: { removeDependencies: ['ffmpeg'] } })
      await expect.poll(async () => (await dependencies()).some(row => row.name === 'ffmpeg'), { timeout: 120000 }).toBe(false)
      await receipt('shared-ffmpeg', { passed: true, oneCopy: true, retainedForSecondSuite: true, installedModules: true })
    }
    completed = true
    await receipt(phase, { passed: true, phase, architecture: process.arch, ...(phase === 'smoke' ? { samples: process.env.DSH_PHALANX_SUITE_SAMPLE ? [process.env.DSH_PHALANX_SUITE_SAMPLE] : ['officecli', 'wecom', 'minimax', 'lark', 'hyperframes'] } : {}), resumed: resuming })
  } catch (error) {
    await receipt(phase + '-failed', { passed: false, phase, stage, error: safe(error instanceof Error ? error.message : String(error)) })
    throw new Error(`Suite acceptance failed in ${phase}/${stage}; see protected stage diagnostics`, { cause: error })
  } finally {
    const stopped = await Promise.allSettled([browser.close(), app.stop(), ...(catalogFixture ? [catalogFixture.close()] : [])])
    const rebuilt = await Promise.allSettled([new CommunityRuntimeDriver(runtime).rebuild()])
    const platformStopped = stopped[1]?.status === 'fulfilled', containersStopped = rebuilt[0]?.status === 'fulfilled'
    await receipt(phase + '-stopped', { completed, platformStopped, scopedMemberContainersStopped: containersStopped, dataRetainedForNextPhase: true })
    cleanupFailed = stopped.some(row => row.status === 'rejected') || !containersStopped
  }
  if (cleanupFailed) throw Error('Owned acceptance process cleanup is incomplete; see protected cleanup receipt')
}, 7200000)
