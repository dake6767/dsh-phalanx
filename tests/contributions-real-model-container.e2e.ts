// Validation: T4 only; real credentials: required (provider keys or deployed account). Never selected by T2.
import { contributionDeclaration } from '../src/domain/contribution-checks.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { startContributionModel } from './support/real-contribution-model.js'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { DSH_REVISION, assertPinnedDshRevision, defaultWorkspacePath, instanceWorkspacePath, runtimeSection } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { signInCommunity, selectCommunityWorkspace } from './fixtures/community-native-browser.js'
import { cookieHeader, createRealDshRpc, rpcBody } from './support/real-dsh-rpc.js'

const inputPath = process.env.DSH_PHALANX_ACCEPTANCE_INPUT
it.skipIf(!inputPath || !runtimeSettings.containerImage)('accepts real-model creator and minimal contributions using a real search credential through the installed candidate', async () => {
  assertPinnedDshRevision(runtimeSettings); expect(process.env.DSH_PHALANX_INSTALL_ROOT).toBeTruthy()
  const inputs = JSON.parse(await readFile(inputPath!, 'utf8')) as { modelApiKey: string, searchApiKey: string }
  expect(!!inputs.modelApiKey && !!inputs.searchApiKey).toBe(true)
  const secrets = [inputs.modelApiKey, inputs.searchApiKey].flatMap(value => [value, JSON.stringify(value).slice(1, -1)])
  const safe = (text: string) => secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text).replace(/:\/\/[^\s/@]+:[^\s/@]+@/gu, '://[redacted]@')
  const hostPublicAddresses = process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES?.split(',').map(value => value.trim()) ?? []
  expect(hostPublicAddresses.length, 'Record the deployment public address inventory').toBeGreaterThan(0)
  const root = await mkdtemp(join(tmpdir(), 'contributions-real-model-')), evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  let stage = 'start', completed = false
  const record = async (name: string, value: unknown) => { if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, name), safe(JSON.stringify(value, null, 2)) + '\n', { mode: 0o600 }) } }
  const setStage = async (value: string) => { stage = value; await record('stage.json', { stage, at: Date.now() }); console.info('Acceptance phase:', stage) }
  const snapshot = async (page: Page, name: string) => { if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true, animations: 'disabled' }) } }
  const patch = join(root, 'probe.json')
  await writeFile(patch, JSON.stringify([{ id: 'web', config: { searchProvider: 'anysearch' } }, { insert: [{ id: 'access-probe', name: '/dsh-phalanx/home/access-probe.mjs' }] }]))
  const model = await startContributionModel(inputs.modelApiKey)
  const runtime = { ...runtimeSection(root, model.origin, runtimeSettings), patches: [runtimeSettings.overlay, patch] }
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'real-contributions-acceptance-session-secret', network: { hostPublicAddresses }, runtime, modelGateway: { upstreamApiKey: inputs.modelApiKey } }, 120000)
  const browser = await chromium.launch({ headless: true }), admin = await browser.newPage({ locale: 'en' })
  const a = await browser.newPage({ locale: 'en' }), b = await browser.newPage({ locale: 'en' }), c = await browser.newPage({ locale: 'en' })
  for (const page of [a, b, c, admin]) page.setDefaultTimeout(60000)
  let origin = ''
  const get = async (path: string) => (await admin.request.get(origin + '/admin/api/' + path)).json()
  const post = async (path: string, data: object) => admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
  const container = async (username: string) => (await execFileText(runtimeSettings.containerRuntimeCli, ['ps', '--filter', 'label=dsh-phalanx.community-root=' + createHash('sha256').update(root).digest('hex'), '--filter', 'label=dsh-phalanx.user=' + username, '--format', '{{.Names}}'])).trim()
  const command = async (username: string, args: readonly string[]) => execFileText(runtimeSettings.containerRuntimeCli, ['exec', await container(username), ...args])
  const turn = async (page: Page, prompt: string) => { const consent = ' Report finding codes without matched values. My explicit choice is to retain every contribution-credential-low warning at every path, including all source, documentation, config files, cordis.patch.yml and declaration.plugin.entriesYaml. This authorizes retainWarnings true on the initial submission or a warning-only retry, followed by my foreground card confirmation. Do not treat needs-review as rejection or as a reason to stop. Never retain a rejected or high-confidence finding; repair those only when this task authorizes repair.'; await page.locator('[data-composer-input]').fill(prompt + consent); await page.locator('[data-composer-input]').press('Enter') }
  const confirm = async (page: Page) => {
    const submit = page.getByRole('button', { name: /Submit answers|Submit answer|Submit$/ }).first()
    await page.getByText('Submit / 提交', { exact: true }).last().waitFor({ timeout: 240000 }); await page.getByText('Submit / 提交', { exact: true }).last().click()
    if (await submit.count()) await submit.click()
  }
  const mode = async (page: Page, _current: string, next: string) => { if (await page.getByRole('button', { name: next, exact: true }).count()) return; await page.getByRole('button', { name: /^(Standard|Creator|Minimal) mode$/ }).first().click(); await page.getByText(next, { exact: true }).last().click() }
  const fresh = async (page: Page) => { await page.getByRole('button', { name: 'New session', exact: true }).first().click(); await selectCommunityWorkspace(page.context(), page, origin, instanceWorkspacePath(defaultWorkspacePath(root, 'member-a'), true), true) }
  const pending = async (kind: string) => (await get('contributions')).contributions.filter((row: { kind?: string, status: string }) => row.status === 'pending' && (row.kind ?? 'skill') === kind)
  const review = async (kind: 'plugins' | 'skills') => { await admin.goto(origin + '/admin/' + kind + '?locale=en'); await admin.getByRole('tab', { name: 'Member contributions', exact: true }).click(); await admin.getByRole('button', { name: 'Review contribution', exact: true }).last().click(); await admin.getByRole('button', { name: 'Adopt contribution', exact: true }).click() }
  const finish = async () => { await admin.getByRole('button', { name: 'Confirm adoption', exact: true }).click(); await admin.getByRole('button', { name: 'Finish adoption', exact: true }).waitFor({ timeout: 180000 }) }
  const restart = async (page: Page, username: string) => { expect((await page.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200); await signInCommunity(page, origin, username, 'password') }
  try {
    origin = await app.start()
    expect((await admin.request.post(origin + '/bootstrap', { headers: { origin }, form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
    for (const username of ['member-a', 'member-b', 'member-c']) {
      expect((await post('accounts', { username, password: 'password', email: '' })).status()).toBe(201)
      const home = join(root, 'users', username, 'home'); await mkdir(home, { recursive: true, mode: 0o700 }); await writeFile(join(home, 'access-probe.mjs'), await readFile(new URL('./fixtures/plugin-access-probe.mjs', import.meta.url)))
    }
    await setStage('member-sign-in')
    await signInCommunity(a, origin, 'member-a', 'password'); await signInCommunity(b, origin, 'member-b', 'password'); await signInCommunity(c, origin, 'member-c', 'password')
    const workspace = defaultWorkspacePath(root, 'member-a'), directory = join(workspace, 'team-anysearch')
    await setStage('creator-source')
    await command('member-a', ['sh', '-c', 'set -eu; mkdir -p "$1"; cd "$1"; npm pack @anysearch/anysearch-dsh@0.1.8 --ignore-scripts --silent > /tmp/anysearch-pack-name; read -r task_pack_file < /tmp/anysearch-pack-name; tar -xzf "$task_pack_file" --strip-components=1; rm -f "$task_pack_file" /tmp/anysearch-pack-name', 'pack', join(instanceWorkspacePath(workspace, true), 'team-anysearch')])
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); manifest.version = '0.1.9'; for (const name of ['_resolved', '_integrity', '_from']) delete manifest[name]
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest)); await writeFile(join(directory, '.env.local'), 'LOCAL_DEVELOPMENT_KEY=excluded-fixture\n')
    await command('member-a', ['sh', '-c', 'set -eu; cd "$1"; npm pack --ignore-scripts --silent --pack-destination /dsh-phalanx/home > /tmp/team-pack-name', 'pack', join(instanceWorkspacePath(workspace, true), 'team-anysearch')])
    const localArchive = (await command('member-a', ['cat', '/tmp/team-pack-name'])).trim()
    // Installation is not idempotent: send it once and preserve the original response or transport error.
    const installationResponse = await a.request.post(new URL('api/pluginManager/installBundle', a.url()).href, {
      data: JSON.parse(rpcBody('pluginManager/installBundle', { spec: '/dsh-phalanx/home/' + localArchive })),
      timeout: 600000, maxRetries: 0, maxRedirects: 0,
    })
    const installationBody = await installationResponse.json()
    await record('creator-install-response.json', { status: installationResponse.status(), body: installationBody })
    expect(installationResponse.status()).toBe(200)
    expect(installationBody.result).toMatchObject({ ok: true })
    const installation = installationBody.result.value
    await record('creator-install-result.json', installation)
    expect(installation).toMatchObject({ changed: true })
    await a.reload(); await selectCommunityWorkspace(a.context(), a, origin, instanceWorkspacePath(workspace, true), true); await mode(a, 'Standard mode', 'Creator mode')
    const goodDeclaration = { purpose: 'Team AnySearch search', plugin: { upstreams: [{ name: 'search', baseUrl: 'https://api.anysearch.com', headers: [{ name: 'Authorization', value: 'Bearer {credential}' }], testRequest: { method: 'GET', path: '/v1/domains' } }], environment: [{ name: 'ANYSEARCH_API_KEY', secret: true, purpose: 'Authenticate search', application: 'AnySearch dashboard' }], entriesYaml: JSON.stringify({ 'web-search-anysearch': { baseURL: '{upstream:search}', apiKeyEnv: 'ANYSEARCH_API_KEY' } }) } }
    const badDeclaration = { ...goodDeclaration, plugin: { ...goodDeclaration.plugin, entriesYaml: JSON.stringify({ 'web-search-anysearch': { baseURL: 'https://api.anysearch.com', apiKeyEnv: 'ANYSEARCH_API_KEY' } }) } }
    await setStage('hardcoded-rejection'); const invalidBefore = model.observations.length
    await turn(a, 'Validate the intentionally hard-coded declaration below. First read package.json in team-anysearch. Do not modify any files, read .env files or print environment values. Call submit_contribution action submit, kind plugin, source local, path team-anysearch, retainWarnings true, with exactly this declaration. I explicitly authorize retaining every low-confidence warning in its files and declaration. Show the foreground confirmation card before upload. Only after an actual rejected status, report its finding and stop without repairing. Warning-retention retries are authorized and are not repairs. Declaration: ' + JSON.stringify(badDeclaration))
    await confirm(a)
    await expect.poll(() => model.observations.slice(invalidBefore).some(row => row.kind === 'plugin' && !row.isError && row.status === 'rejected' && row.codes.includes('contribution-plugin-upstream-unused')), { timeout: 180000 }).toBe(true)
    expect(await pending('plugin')).toHaveLength(0); await snapshot(a, 'real-creator-hardcoded-rejected')
    await setStage('corrected-contribution')
    let repairBefore = model.observations.length
    const repairPrompt = 'Complete all package edits before submitting: verify CHANGELOG.md exists and package.json files includes it. Never submit midway through a todo list. Repair team-anysearch according to the platform findings. You are authorized to fix new validation rejections and retry; never retain a high-confidence or rejected finding. Inspect and modify the local AnySearch plugin only as needed so baseURL and apiKeyEnv are honored. The platform expands {upstream:search} in the declaration into its authenticated proxy URL before applying managed entries. Plugin code treats baseURL as an ordinary URL, not a template resolved through ctx.upstreams. Keep cordis.patch.yml standalone, without platform placeholders, credentials or network calls at activation. Preserve the public web-search service. Add CHANGELOG.md and include it in package.json files. Preserve existing documentation credential placeholders, or delete inline credential examples; do not introduce replacement key values. Leave no scratch scripts, node_modules or symlinks. Do not read .env files or print credentials. Submit with this value-free declaration and wait for my foreground confirmation: ' + JSON.stringify(goodDeclaration)
    await turn(a, repairPrompt)
    for (let attempt = 0; attempt < 3; attempt++) {
      const rejected = () => model.observations.slice(repairBefore).findLast(row => row.kind === 'plugin' && row.status === 'rejected')
      await expect.poll(async () => await a.getByRole('button', { name: /Submit answers|Submit answer|Submit$/ }).first().isVisible() || !!rejected(), { timeout: 240000 }).toBe(true)
      if (!rejected()) { const previous = (await pending('plugin'))[0]?.revision; await confirm(a); await expect.poll(async () => (await pending('plugin')).some((row: { revision: string }) => row.revision !== previous) || !!rejected(), { timeout: 240000 }).toBe(true) }
      if ((await pending('plugin')).some((row: { files: string[] }) => row.files.includes('CHANGELOG.md'))) break
      if (attempt === 2) throw Error('Creator repairs still rejected: ' + JSON.stringify(rejected()?.codes))
      const codes = rejected()?.codes ?? ['pending package is missing required CHANGELOG.md']; repairBefore = model.observations.length
      await turn(a, 'The actual receipt needs correction: ' + JSON.stringify(codes) + '. Fix the reported causes before retrying; do not retain rejected findings. ' + repairPrompt)
    }
    expect(await pending('plugin')).toHaveLength(1)
    const first = (await pending('plugin'))[0]; expect(first.files).not.toContain('.env.local'); expect(first.files).toContain('CHANGELOG.md')
    await record('creator-package.json', Object.fromEntries(await Promise.all(['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'CHANGELOG.md'].map(async name => [name, await readFile(join(directory, name), 'utf8')]))))
    await a.getByRole('button', { name: 'Plugins', exact: true }).click(); await a.getByRole('button', { name: /@anysearch\/anysearch-dsh/ }).first().click(); await a.getByRole('button', { name: 'Withdraw contribution', exact: true }).waitFor(); await snapshot(a, 'real-native-pending')
    await setStage('administrator-adoption')
    await review('plugins'); await admin.getByLabel('Platform credential', { exact: true }).fill(inputs.searchApiKey)
    await admin.getByRole('button', { name: 'Test upstream', exact: true }).click(); await admin.getByText('HTTP 200', { exact: true }).waitFor({ timeout: 120000 })
    await admin.getByRole('button', { name: 'Continue to distribution', exact: true }).click(); await admin.getByText('Publish to Platform App Center', { exact: true }).click(); await admin.getByText('Confirm platform credential sharing', { exact: true }).click()
    const groups = await get('groups'), group = groups.find((row: { isDefault: boolean }) => row.isDefault)
    await admin.getByText(group.name, { exact: true }).click(); await finish(); await snapshot(admin, 'real-adopted-search')
    const selected = (await get('plugins')).find((row: { packageName: string }) => row.packageName === '@anysearch/anysearch-dsh'); expect(selected.provenance.maintainer.username).toBe('member-a')
    await record('adopted-access.json', { access: await get('plugins/access?packageName=%40anysearch%2Fanysearch-dsh'), grants: await get('groups/' + group.id + '/plugins') })
    await setStage('other-member-search')
    await restart(b, 'member-b')
    await expect.poll(async () => {
      const rows = await createRealDshRpc().remoteRpc<Array<{ entryId: string, moduleName: string, bundleName?: string, fiberPhase: string }>>(origin, await cookieHeader(b.context(), origin), 'pluginManager/listPlugins', {})
      await record('member-plugin-inventory.json', rows.map(({ entryId, moduleName, fiberPhase }) => ({ entryId, moduleName, fiberPhase })))
      const sample = rows.filter(row => row.moduleName === '@anysearch/anysearch-dsh' || row.bundleName === '@anysearch/anysearch-dsh' || row.moduleName.includes('/node_modules/@anysearch/anysearch-dsh/'))
      return sample.length > 0 && sample.every(row => row.fiberPhase === 'active')
    }, { timeout: 60000 }).toBe(true)
    const found = await b.request.get(new URL('access-probe', b.url()).href), searchBody = await found.text()
    await record('search-response.json', { status: found.status(), body: safe(searchBody).slice(0, 8000) }); expect(found.status()).toBe(200)
    const search = JSON.parse(searchBody); expect(search.sources.length).toBeGreaterThan(0)
    await record('real-search.json', { status: found.status(), sources: search.sources.map((row: { url?: string, title?: string }) => ({ url: row.url, title: row.title })) })
    await b.getByRole('button', { name: 'Platform App Center', exact: true }).click(); await b.getByRole('tab', { name: 'Plugins', exact: true }).click(); await b.getByText('Contributed by member-a', { exact: true }).waitFor(); await snapshot(b, 'real-contributed-card')
    const adoptedVersion = String((await get('plugins'))[0].version)
    const versionParts = /^(\d+)\.(\d+)\.(\d+)$/.exec(adoptedVersion)
    expect(versionParts).not.toBeNull()
    const updatedVersion = `${versionParts![1]}.${versionParts![2]}.${Number(versionParts![3]) + 1}`
    await setStage('maintainer-update')
    await a.getByRole('switch', { name: 'Use my local copy', exact: true }).click(); await expect.poll(async () => (await (await a.request.get(origin + '/market/api/plugins/contribution?packageName=%40anysearch%2Fanysearch-dsh')).json()).localCopy?.enabled).toBe(true); await restart(a, 'member-a')
    await fresh(a); await turn(a, `Update ONLY the writable local workspace ./team-anysearch contribution. The adopted platform version is ${adoptedVersion}; increase package.json and matching version metadata to ${updatedVersion}, add an update entry in CHANGELOG.md, preserve public web-search behavior and use this value-free declaration. Preserve dsh.bundle.patch as a single ./relative-file string, never an array. Repair any rejected package findings before retrying; never retain a rejected finding. The source directory is already selected. Do not read or print credentials. Then submit_contribution kind plugin source local path team-anysearch and wait for my card confirmation: ` + JSON.stringify(goodDeclaration))
    // A rejected model submission can be followed by its repaired package and a new foreground card.
    // Confirm each actual card; the first rejected attempt is not an uploaded contribution.
    for (let confirmation = 0; confirmation < 3; confirmation++) {
      const updated = async () => (await pending('plugin')).length === 1
      await expect.poll(async () => await updated() || await a.getByRole('button', { name: /Submit answers|Submit answer|Submit$/ }).first().isVisible(), { timeout: 240000 }).toBe(true)
      if (await updated()) break
      const before = model.observations.length
      await confirm(a)
      await expect.poll(async () => await updated() || model.observations.slice(before).some(row => row.kind === 'plugin' && !row.isError), { timeout: 240000 }).toBe(true)
      if (await updated()) break
    }
    await expect.poll(async () => (await pending('plugin')).length, { timeout: 240000 }).toBe(1)
    await review('plugins'); expect(await admin.getByLabel('Platform credential', { exact: true }).inputValue()).toBe(''); await admin.getByRole('button', { name: 'Continue to distribution', exact: true }).click(); await finish()
    expect((await get('plugins'))[0]).toMatchObject({ version: updatedVersion, published: true, provenance: { maintainer: { username: 'member-a' } } })
    await a.getByRole('button', { name: 'Plugins', exact: true }).click(); await a.getByRole('button', { name: /@anysearch\/anysearch-dsh/ }).first().click(); await a.getByRole('switch', { name: 'Use my local copy', exact: true }).click(); await restart(a, 'member-a'); await restart(b, 'member-b')
    expect((await b.request.get(new URL('access-probe', b.url()).href)).status()).toBe(200)
    await setStage('nonmaintainer-rejection'); const nonMaintainerBefore = model.observations.length
    const otherWorkspace = defaultWorkspacePath(root, 'member-c'); await cp(directory, join(otherWorkspace, 'team-anysearch'), { recursive: true }); const otherManifest = { ...manifest, version: `${versionParts![1]}.${versionParts![2]}.${Number(versionParts![3]) + 2}` }; await writeFile(join(otherWorkspace, 'team-anysearch/package.json'), JSON.stringify(otherManifest))
    await selectCommunityWorkspace(c.context(), c, origin, instanceWorkspacePath(otherWorkspace, true), true)
    await turn(c, 'Call submit_contribution now with kind plugin, source local and path team-anysearch using this declaration. Do not read or print credentials. The requested confirmation is the platform submission card produced by that tool; do not ask a separate preflight question. Invoke the tool first, then wait for my platform card confirmation: ' + JSON.stringify(goodDeclaration)); await confirm(c)
    await expect.poll(() => model.observations.slice(nonMaintainerBefore).some(row => row.kind === 'plugin' && !row.isError && row.codes.includes('contribution-maintainer-required')), { timeout: 180000 }).toBe(true); expect((await (await c.request.get(origin + '/market/api/contributions')).json()).contributions).toEqual([]); await snapshot(c, 'real-nonmaintainer-rejected')
    await setStage('skill-credential-rejection'); const credentialBefore = model.observations.length
    const skill = join(workspace, 'team-search-skill'); await mkdir(skill); await writeFile(join(skill, 'SKILL.md'), '---\nname: team-search-skill\ndescription: Query AnySearch domains with delegated platform credentials.\n---\nRun ./query.mjs. Credentials are provided by the platform.\n'); await writeFile(join(skill, '.env'), 'EXAMPLE_KEY=excluded-fixture\n'); await writeFile(join(skill, 'query.mjs'), 'const apiKey="Q8rB3mZ7xK2nV9sP4cD6hF1tL5aE0wY"; console.log("unsafe fixture");\n')
    await fresh(a); await turn(a, 'Validate the rejection branch first: do not modify files yet; call submit_contribution action submit path team-search-skill purpose Team search skill. Do not read .env or print credentials. Let the scanner reject the hard-coded test credential. After rejection report the finding and stop; do not repair or retry until my next message.')
    await expect.poll(() => model.observations.slice(credentialBefore).some(row => row.kind === 'skill' && !row.isError && row.status === 'rejected' && row.codes.includes('contribution-credential-high')), { timeout: 180000 }).toBe(true); expect(await pending('skill')).toHaveLength(0)
    const skillSubmission = contributionDeclaration({ purpose: 'Team search skill', execution: { commands: [{ command: './query.mjs', blocked: [] }], variables: [{ name: 'TEAM_ANYSEARCH_KEY', purpose: 'Authenticate AnySearch', application: 'AnySearch dashboard' }] } })
    await turn(a, 'Repair team-search-skill/query.mjs: make it an executable Node module that GETs https://api.anysearch.com/v1/domains using Authorization Bearer from process.env.TEAM_ANYSEARCH_KEY, prints only ANYSEARCH_DOMAINS_OK when response.ok, and never prints the key. No npm dependencies or prepare command. Submit using exactly this complete JSON declaration; variables must remain inside execution: ' + JSON.stringify(skillSubmission) + '. Do not read .env files. Invoke the contribution tool first, then wait for my platform submission card confirmation; do not ask a separate preflight question.')
    await confirm(a); await expect.poll(async () => (await pending('skill')).length, { timeout: 120000 }).toBe(1); expect((await pending('skill'))[0].files).not.toContain('.env')
    const skillDeclaration = (await pending('skill'))[0].declaration
    await setStage('skill-platform-execution')
    await review('skills'); await admin.getByLabel('Credential value', { exact: true }).fill(inputs.searchApiKey); await admin.getByText('Enable platform execution', { exact: true }).click(); await admin.getByRole('button', { name: 'Continue to distribution', exact: true }).click(); await admin.getByText(group.name, { exact: true }).click(); await finish()
    await admin.getByRole('button', { name: 'Approve execution', exact: true }).click()
    await expect.poll(async () => (await get('skills/execution?name=team-search-skill')).awaitingPreparation, { timeout: 180000 }).toBe(false)
    await expect.poll(async () => (await get('skills/execution?name=team-search-skill')).preparation?.stage, { timeout: 180000 }).toBe('ready')
    expect(await command('member-b', ['node', '/dsh-phalanx/member-skills/live/team-search-skill/query.mjs'])).toContain('ANYSEARCH_DOMAINS_OK')
    await snapshot(admin, 'real-skill-execution')
    await setStage('skill-update')
    await admin.getByRole('button', { name: 'Finish adoption', exact: true }).click(); await fresh(a)
    await turn(a, 'Update ONLY the writable local workspace directory ./team-search-skill (not the installed read-only skill or team-anysearch). Add CHANGELOG.md describing the shared workflow, then submit kind skill with path team-search-skill. The submission target is already selected; do not ask which directory. Preserve query.mjs, never read .env or print credentials. Reuse exactly the following accepted value-free declaration; do not infer a different executable or add requiredCommands. Submit the updated skill and wait for my confirmation: ' + JSON.stringify(skillDeclaration))
    await confirm(a); await expect.poll(async () => (await pending('skill')).length, { timeout: 120000 }).toBe(1)
    expect((await pending('skill'))[0].declaration).toEqual(skillDeclaration)
    await review('skills'); expect(await admin.getByLabel('Credential value', { exact: true }).inputValue()).toBe(''); await admin.getByRole('button', { name: 'Continue to distribution', exact: true }).click(); await finish()
    expect((await get('skills/execution?name=team-search-skill')).awaitingPreparation).toBe(true)
    await expect(command('member-b', ['node', '/dsh-phalanx/member-skills/live/team-search-skill/query.mjs'])).rejects.toThrow(/not-ready/)
    await admin.getByRole('button', { name: 'Approve execution', exact: true }).click(); await expect.poll(async () => (await get('skills/execution?name=team-search-skill')).awaitingPreparation, { timeout: 180000 }).toBe(false); await expect.poll(async () => (await get('skills/execution?name=team-search-skill')).preparation?.stage, { timeout: 180000 }).toBe('ready')
    expect(await command('member-b', ['node', '/dsh-phalanx/member-skills/live/team-search-skill/query.mjs'])).toContain('ANYSEARCH_DOMAINS_OK')

    await setStage('minimal-discovery')
    const minimal = join(workspace, 'minimal-guide'); await mkdir(minimal); await writeFile(join(minimal, 'SKILL.md'), '---\nname: minimal-guide\ndescription: A simple shared guide.\n---\nFollow the team checklist.\n')
    await fresh(a); await mode(a, 'Creator mode', 'Minimal mode'); await turn(a, 'Read minimal-guide/SKILL.md and contribute this skill to the platform using the available contribution tool. Purpose: share the team checklist. Do not read .env or print credentials. Wait for my confirmation.')
    await confirm(a); await expect.poll(async () => (await pending('skill')).some((row: { name: string }) => row.name === 'minimal-guide'), { timeout: 120000 }).toBe(true); await snapshot(a, 'real-minimal-confirmed')
    await setStage('readable-files-scan')
    await writeFile(join(root, 'users/member-b/home/readable-scan.mjs'), await readFile(new URL('./fixtures/contribution-readable-scan.mjs', import.meta.url)))
    const scan = spawn(runtimeSettings.containerRuntimeCli, ['exec', await container('member-b'), 'node', '/dsh-phalanx/home/readable-scan.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const patterns = secrets.map(value => Buffer.from(value)), max = Math.max(...patterns.map(value => value.length)); let tail = Buffer.alloc(0), leaked = false, report = ''
    scan.stdout.on('data', bytes => { const block = Buffer.concat([tail, bytes]); if (patterns.some(value => block.includes(value))) leaked = true; tail = block.subarray(Math.max(0, block.length - max + 1)) }); scan.stderr.on('data', bytes => { report += bytes.toString() })
    const code = await new Promise<number | null>((resolve, reject) => { scan.once('error', reject); scan.once('close', resolve) }); expect(code).toBe(0); expect(leaked).toBe(false)
    const inventory = JSON.parse(report); expect(inventory.files).toBeGreaterThan(1000); expect(inventory.errors).toEqual([]); await record('credential-scan.json', { ...inventory, platformCredentialFound: leaked })
    await record('tool-results.json', model.observations); completed = true
  } catch (error) {
    const packageRoot = join(defaultWorkspacePath(root, 'member-a'), 'team-anysearch')
    await record('creator-package-diagnostic.json', Object.fromEntries(await Promise.all(['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/version.js', 'CHANGELOG.md'].map(async name => [name, await readFile(join(packageRoot, name), 'utf8').catch(() => null)]))))
    await record('model-transfers.json', model.transfers); await record('tool-results.json', model.observations)
    for (const [name, page] of [['member-a', a], ['member-b', b], ['member-c', c]] as const) {
      await record(name + '-diagnostic.json', { stage, text: safe((await page.locator('body').innerText().catch(() => '')).slice(-24000)) })
    }
    await record('real-model-failure.json', { stage, error: safe(String(error)) })
    throw new Error('Real contribution acceptance failed at ' + stage + ': ' + safe(String(error)))
  }
  finally {
    await browser.close(); await app.stop(); await model.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
    await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([]); await artifacts.collect([])
    await new FileExecutionArtifacts(join(root, 'execution/artifacts')).collect([]); await rm(root, { recursive: true, force: true })
    if (!completed) console.info('Real contribution acceptance failed at', stage)
  }
  await record('real-model-result.json', { passed: true, candidate: process.env.DSH_PHALANX_CANDIDATE_SHA, dsh: DSH_REVISION, creator: true, realModel: true, realSearchCredential: true, maintainerUpdate: true, nonMaintainerRejected: true, delegatedSkillCredential: true, minimal: true, cleanup: true })
}, 1800000)
