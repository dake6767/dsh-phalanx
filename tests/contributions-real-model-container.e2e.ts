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
import { assertPinnedDshRevision, defaultWorkspacePath, instanceWorkspacePath, runtimeSection } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { signInCommunity, selectCommunityWorkspace } from './fixtures/community-native-browser.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'

const inputPath = process.env.DSH_PHALANX_ACCEPTANCE_INPUT
it.skipIf(!inputPath || !runtimeSettings.containerImage)('accepts real-model creator and minimal contributions using a real search credential through the installed candidate', async () => {
  assertPinnedDshRevision(runtimeSettings); expect(process.env.DSH_PHALANX_INSTALL_ROOT).toBeTruthy()
  const inputs = JSON.parse(await readFile(inputPath!, 'utf8')) as { modelApiKey: string, searchApiKey: string }
  expect(!!inputs.modelApiKey && !!inputs.searchApiKey).toBe(true)
  const secrets = [inputs.modelApiKey, inputs.searchApiKey].flatMap(value => [value, JSON.stringify(value).slice(1, -1)])
  const safe = (text: string) => secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text)
  const root = await mkdtemp(join(tmpdir(), 'contributions-real-model-')), evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  let stage = 'start', completed = false
  const record = async (name: string, value: unknown) => { if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, name), safe(JSON.stringify(value, null, 2)) + '\n', { mode: 0o600 }) } }
  const setStage = async (value: string) => { stage = value; await record('stage.json', { stage, at: Date.now() }); console.info('Acceptance phase:', stage) }
  const snapshot = async (page: Page, name: string) => { if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true, animations: 'disabled' }) } }
  const patch = join(root, 'probe.json')
  await writeFile(patch, JSON.stringify([{ id: 'web', config: { searchProvider: 'anysearch' } }, { insert: [{ id: 'access-probe', name: '/dsh-phalanx/home/access-probe.mjs' }] }]))
  const model = await startContributionModel(inputs.modelApiKey)
  const runtime = { ...runtimeSection(root, model.origin, runtimeSettings), patches: [runtimeSettings.overlay, patch] }
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'real-contributions-acceptance-session-secret', runtime, modelGateway: { upstreamApiKey: inputs.modelApiKey } }, 120000)
  const browser = await chromium.launch({ headless: true }), admin = await browser.newPage({ locale: 'en' })
  const a = await browser.newPage({ locale: 'en' }), b = await browser.newPage({ locale: 'en' }), c = await browser.newPage({ locale: 'en' })
  for (const page of [a, b, c, admin]) page.setDefaultTimeout(60000)
  let origin = ''
  const get = async (path: string) => (await admin.request.get(origin + '/admin/api/' + path)).json()
  const post = async (path: string, data: object) => admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
  const container = async (username: string) => (await execFileText(runtimeSettings.containerRuntimeCli, ['ps', '--filter', 'label=dsh-phalanx.community-root=' + createHash('sha256').update(root).digest('hex'), '--filter', 'label=dsh-phalanx.user=' + username, '--format', '{{.Names}}'])).trim()
  const command = async (username: string, args: readonly string[]) => execFileText(runtimeSettings.containerRuntimeCli, ['exec', await container(username), ...args])
  const turn = async (page: Page, prompt: string) => { const consent = ' Report returned finding codes verbatim without matched values. For benign documentation domains and variable-name false positives reported as warnings, I explicitly choose to retain those warnings; report them and use retainWarnings true, then show the foreground confirmation card. Never retain a rejected or high-confidence credential finding.'; await page.locator('[data-composer-input]').fill(prompt + consent); await page.locator('[data-composer-input]').press('Enter') }
  const confirm = async (page: Page) => {
    const submit = page.getByRole('button', { name: /Submit answers|Submit answer|Submit$/ }).first()
    await submit.waitFor({ timeout: 240000 }); await page.getByText('Submit / 提交', { exact: true }).last().click()
    if (await submit.count()) await submit.click()
  }
  const mode = async (page: Page, _current: string, next: string) => { if (await page.getByRole('button', { name: next, exact: true }).count()) return; await page.getByRole('button', { name: /^(Standard|Creator|Minimal) mode$/ }).first().click(); await page.getByText(next, { exact: true }).last().click() }
  const fresh = async (page: Page) => { await page.getByRole('button', { name: 'New session', exact: true }).first().click() }
  const pending = async (kind: string) => (await get('contributions')).contributions.filter((row: { kind?: string, status: string }) => row.status === 'pending' && (row.kind ?? 'skill') === kind)
  const review = async (kind: 'plugins' | 'skills') => { await admin.goto(origin + '/admin/' + kind + '?locale=en'); await admin.getByRole('tab', { name: 'Member contributions', exact: true }).click(); await admin.getByRole('button', { name: 'Review contribution', exact: true }).last().click(); await admin.getByRole('button', { name: 'Adopt contribution', exact: true }).click() }
  const finish = async () => { await admin.getByRole('button', { name: 'Confirm adoption', exact: true }).click(); await admin.getByRole('button', { name: 'Finish adoption', exact: true }).waitFor({ timeout: 180000 }) }
  const restart = async (page: Page, username: string) => { expect((await page.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200); await signInCommunity(page, origin, username, 'password') }
  try {
    origin = await app.start()
    expect((await admin.request.post(origin + '/bootstrap', { headers: { origin }, form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
    for (const username of ['member-a', 'member-b', 'member-c']) {
      expect((await post('accounts', { username, password: 'password', email: '' })).status()).toBe(201)
      const home = join(root, 'users', username, 'home'); await mkdir(home, { recursive: true }); await writeFile(join(home, 'access-probe.mjs'), await readFile(new URL('./fixtures/plugin-access-probe.mjs', import.meta.url)))
    }
    await signInCommunity(a, origin, 'member-a', 'password'); await signInCommunity(b, origin, 'member-b', 'password'); await signInCommunity(c, origin, 'member-c', 'password')
    const workspace = defaultWorkspacePath(root, 'member-a'), directory = join(workspace, 'team-anysearch')
    await setStage('creator-source')
    await command('member-a', ['sh', '-c', 'mkdir -p "$1"; cd "$1"; npm pack @anysearch/anysearch-dsh@0.1.8 --ignore-scripts --silent > /tmp/anysearch-pack-name; read -r task_pack_file < /tmp/anysearch-pack-name; tar -xzf "$task_pack_file" --strip-components=1; rm -f "$task_pack_file" /tmp/anysearch-pack-name', 'pack', join(instanceWorkspacePath(workspace, true), 'team-anysearch')])
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); manifest.version = '0.1.9'; for (const name of ['_resolved', '_integrity', '_from']) delete manifest[name]
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest)); await writeFile(join(directory, '.env.local'), 'LOCAL_DEVELOPMENT_KEY=excluded-fixture\n')
    await command('member-a', ['sh', '-c', 'cd "$1"; npm pack --ignore-scripts --silent --pack-destination /dsh-phalanx/home > /tmp/team-pack-name', 'pack', join(instanceWorkspacePath(workspace, true), 'team-anysearch')])
    const localArchive = (await command('member-a', ['cat', '/tmp/team-pack-name'])).trim()
    expect(await createRealDshRpc().remoteRpc(origin, await cookieHeader(a.context(), origin), 'pluginManager/installBundle', { spec: '/dsh-phalanx/home/' + localArchive })).toMatchObject({ changed: true })
    await a.reload(); await selectCommunityWorkspace(a.context(), a, origin, instanceWorkspacePath(workspace, true), true); await mode(a, 'Standard mode', 'Creator mode')
    const goodDeclaration = { purpose: 'Team AnySearch search', plugin: { upstreams: [{ name: 'search', baseUrl: 'https://api.anysearch.com', headers: [{ name: 'Authorization', value: 'Bearer {credential}' }], testRequest: { method: 'GET', path: '/v1/domains' } }], environment: [{ name: 'ANYSEARCH_API_KEY', secret: true, purpose: 'Authenticate search', application: 'AnySearch dashboard' }], entriesYaml: JSON.stringify({ 'web-search-anysearch': { baseURL: '{upstream:search}', apiKeyEnv: 'ANYSEARCH_API_KEY' } }) } }
    const badDeclaration = { ...goodDeclaration, plugin: { ...goodDeclaration.plugin, entriesYaml: JSON.stringify({ 'web-search-anysearch': { baseURL: 'https://api.anysearch.com', apiKeyEnv: 'ANYSEARCH_API_KEY' } }) } }
    await setStage('hardcoded-rejection'); const invalidBefore = model.observations.length
    await turn(a, 'We are testing the contribution rejection branch. First read package.json in team-anysearch. Do not modify any files yet and do not read .env files or print environment values. Call submit_contribution action submit, kind plugin, source local, path team-anysearch, with exactly this intentionally hard-coded declaration. The platform must reject it; let me confirm the card before upload. After rejection report the finding and stop; do not repair or retry until my next message. Declaration: ' + JSON.stringify(badDeclaration))
    await confirm(a)
    await expect.poll(() => model.observations.slice(invalidBefore).some(row => row.kind === 'plugin' && !row.isError && row.status === 'rejected' && row.codes.includes('contribution-plugin-upstream-unused')), { timeout: 180000 }).toBe(true)
    expect(await pending('plugin')).toHaveLength(0); await snapshot(a, 'real-creator-hardcoded-rejected')
    await setStage('corrected-contribution')
    await turn(a, 'Now repair the contribution according to the platform finding. Inspect and modify the local AnySearch plugin if necessary so the baseURL and apiKeyEnv configuration are honored. Preserve its public web-search service. Add CHANGELOG.md explaining this team contribution. Do not read .env files or print credentials. Submit team-anysearch with this corrected value-free declaration and wait for my confirmation: ' + JSON.stringify(goodDeclaration))
    await confirm(a); await expect.poll(async () => (await pending('plugin')).length, { timeout: 240000 }).toBe(1)
    const first = (await pending('plugin'))[0]; expect(first.files).not.toContain('.env.local'); expect(first.files).toContain('CHANGELOG.md')
    await a.getByRole('button', { name: 'Plugins', exact: true }).click(); await a.getByRole('button', { name: /@anysearch\/anysearch-dsh/ }).first().click(); await a.getByRole('button', { name: 'Withdraw contribution', exact: true }).waitFor(); await snapshot(a, 'real-native-pending')
    await setStage('administrator-adoption')
    await review('plugins'); await admin.getByLabel('Platform credential', { exact: true }).fill(inputs.searchApiKey)
    await admin.getByRole('button', { name: 'Test upstream', exact: true }).click(); await admin.getByText('HTTP 200', { exact: true }).waitFor({ timeout: 120000 })
    await admin.getByRole('button', { name: 'Continue to distribution', exact: true }).click(); await admin.getByText('Publish to Platform App Center', { exact: true }).click(); await admin.getByText('Confirm platform credential sharing', { exact: true }).click()
    const groups = await get('groups'), group = groups.find((row: { isDefault: boolean }) => row.isDefault)
    await admin.getByText(group.name, { exact: true }).click(); await finish(); await snapshot(admin, 'real-adopted-search')
    const selected = (await get('plugins')).find((row: { packageName: string }) => row.packageName === '@anysearch/anysearch-dsh'); expect(selected.provenance.maintainer.username).toBe('member-a')
    await setStage('other-member-search')
    await restart(b, 'member-b')
    const found = await b.request.get(new URL('access-probe', b.url()).href); expect(found.status()).toBe(200)
    const search = await found.json(); expect(search.sources.length).toBeGreaterThan(0)
    await record('real-search.json', { status: found.status(), sources: search.sources.map((row: { url?: string, title?: string }) => ({ url: row.url, title: row.title })) })
    await b.getByRole('button', { name: 'Platform App Center', exact: true }).click(); await b.getByRole('tab', { name: 'Plugins', exact: true }).click(); await b.getByText('Contributed by member-a', { exact: true }).waitFor(); await snapshot(b, 'real-contributed-card')
    await setStage('maintainer-update')
    await a.getByRole('switch', { name: 'Use my local copy', exact: true }).click(); await expect.poll(async () => (await (await a.request.get(origin + '/market/api/plugins/contribution?packageName=%40anysearch%2Fanysearch-dsh')).json()).localCopy?.enabled).toBe(true); await restart(a, 'member-a')
    await fresh(a); await turn(a, 'Update the local team-anysearch contribution: increase package.json version above 0.1.9 to 0.1.10, add an update entry in CHANGELOG.md, preserve public web-search behavior and use this value-free declaration. Do not read or print credentials. Then submit_contribution kind plugin source local path team-anysearch and wait for my card confirmation: ' + JSON.stringify(goodDeclaration))
    await confirm(a); await expect.poll(async () => (await pending('plugin')).length, { timeout: 240000 }).toBe(1)
    await review('plugins'); expect(await admin.getByLabel('Platform credential', { exact: true }).inputValue()).toBe(''); await admin.getByRole('button', { name: 'Continue to distribution', exact: true }).click(); await finish()
    expect((await get('plugins'))[0]).toMatchObject({ version: '0.1.10', published: true, provenance: { maintainer: { username: 'member-a' } } })
    await a.getByRole('button', { name: 'Plugins', exact: true }).click(); await a.getByRole('button', { name: /@anysearch\/anysearch-dsh/ }).first().click(); await a.getByRole('switch', { name: 'Use my local copy', exact: true }).click(); await restart(a, 'member-a'); await restart(b, 'member-b')
    expect((await b.request.get(new URL('access-probe', b.url()).href)).status()).toBe(200)
    await setStage('nonmaintainer-rejection'); const nonMaintainerBefore = model.observations.length
    const otherWorkspace = defaultWorkspacePath(root, 'member-c'); await cp(directory, join(otherWorkspace, 'team-anysearch'), { recursive: true }); const otherManifest = { ...manifest, version: '0.1.11' }; await writeFile(join(otherWorkspace, 'team-anysearch/package.json'), JSON.stringify(otherManifest))
    await selectCommunityWorkspace(c.context(), c, origin, instanceWorkspacePath(otherWorkspace, true), true)
    await turn(c, 'Submit the team-anysearch plugin directory as a local contribution with this declaration, without reading or printing credentials, and wait for my confirmation: ' + JSON.stringify(goodDeclaration)); await confirm(c)
    await expect.poll(() => model.observations.slice(nonMaintainerBefore).some(row => row.kind === 'plugin' && !row.isError && row.codes.includes('contribution-maintainer-required')), { timeout: 180000 }).toBe(true); expect((await (await c.request.get(origin + '/market/api/contributions')).json()).contributions).toEqual([]); await snapshot(c, 'real-nonmaintainer-rejected')
    await setStage('skill-credential-rejection'); const credentialBefore = model.observations.length
    const skill = join(workspace, 'team-search-skill'); await mkdir(skill); await writeFile(join(skill, 'SKILL.md'), '---\nname: team-search-skill\ndescription: Query AnySearch domains with delegated platform credentials.\n---\nRun ./query.mjs. Credentials are provided by the platform.\n'); await writeFile(join(skill, '.env'), 'EXAMPLE_KEY=excluded-fixture\n'); await writeFile(join(skill, 'query.mjs'), 'const apiKey="Q8rB3mZ7xK2nV9sP4cD6hF1tL5aE0wY"; console.log("unsafe fixture");\n')
    await fresh(a); await turn(a, 'Validate the rejection branch first: do not modify files yet; call submit_contribution action submit path team-search-skill purpose Team search skill. Do not read .env or print credentials. Let the scanner reject the hard-coded test credential. After rejection report the finding and stop; do not repair or retry until my next message.')
    await expect.poll(() => model.observations.slice(credentialBefore).some(row => row.kind === 'skill' && !row.isError && row.status === 'rejected' && row.codes.includes('contribution-credential-high')), { timeout: 180000 }).toBe(true); expect(await pending('skill')).toHaveLength(0)
    await turn(a, 'Repair team-search-skill/query.mjs: make it an executable Node module that GETs https://api.anysearch.com/v1/domains using Authorization Bearer from process.env.TEAM_ANYSEARCH_KEY, prints only ANYSEARCH_DOMAINS_OK when response.ok, and never prints the key. No npm dependencies or prepare command. Submit using a declaration with purpose Team search skill, execution commands [{command:"./query.mjs",blocked:[]}], variables [{name:"TEAM_ANYSEARCH_KEY",purpose:"Authenticate AnySearch",application:"AnySearch dashboard"}]. Do not read .env files. Wait for my confirmation.')
    await confirm(a); await expect.poll(async () => (await pending('skill')).length, { timeout: 120000 }).toBe(1); expect((await pending('skill'))[0].files).not.toContain('.env')
    await setStage('skill-platform-execution')
    await review('skills'); await admin.getByLabel('Credential value', { exact: true }).fill(inputs.searchApiKey); await admin.getByText('Enable platform execution', { exact: true }).click(); await admin.getByRole('button', { name: 'Continue to distribution', exact: true }).click(); await admin.getByText(group.name, { exact: true }).click(); await finish()
    await admin.getByRole('button', { name: 'Prepare', exact: true }).click(); await expect.poll(async () => (await get('skills/execution?name=team-search-skill')).preparation?.stage, { timeout: 180000 }).toBe('ready')
    expect(await command('member-b', ['node', '/dsh-phalanx/member-skills/live/team-search-skill/query.mjs'])).toContain('ANYSEARCH_DOMAINS_OK')
    await snapshot(admin, 'real-skill-execution')
    await setStage('skill-update')
    await admin.getByRole('button', { name: 'Finish adoption', exact: true }).click(); await fresh(a)
    await turn(a, 'Update team-search-skill by adding CHANGELOG.md describing the shared workflow. Preserve query.mjs and its value-free declaration with ./query.mjs and TEAM_ANYSEARCH_KEY, never read .env or print credentials. Submit the updated skill and wait for my confirmation.')
    await confirm(a); await expect.poll(async () => (await pending('skill')).length, { timeout: 120000 }).toBe(1)
    await review('skills'); expect(await admin.getByLabel('Credential value', { exact: true }).inputValue()).toBe(''); await admin.getByRole('button', { name: 'Continue to distribution', exact: true }).click(); await finish()
    expect((await get('skills/execution?name=team-search-skill')).awaitingPreparation).toBe(true)
    await expect(command('member-b', ['node', '/dsh-phalanx/member-skills/live/team-search-skill/query.mjs'])).rejects.toThrow(/not-ready/)
    await admin.getByRole('button', { name: 'Prepare', exact: true }).click(); await expect.poll(async () => (await get('skills/execution?name=team-search-skill')).awaitingPreparation, { timeout: 180000 }).toBe(false); await expect.poll(async () => (await get('skills/execution?name=team-search-skill')).preparation?.stage, { timeout: 180000 }).toBe('ready')
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
  } catch (error) { await record('real-model-failure.json', { stage, error: safe(String(error)) }); throw new Error('Real contribution acceptance failed at ' + stage + ': ' + safe(String(error))) }
  finally {
    await browser.close(); await app.stop(); await model.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
    await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([]); await artifacts.collect([])
    await new FileExecutionArtifacts(join(root, 'execution/artifacts')).collect([]); await rm(root, { recursive: true, force: true })
    if (!completed) console.info('Real contribution acceptance failed at', stage)
  }
  await record('real-model-result.json', { passed: true, candidate: process.env.DSH_PHALANX_CANDIDATE_SHA, dsh: 'd743267388641bc76f17c45ce8b4c231aed1d32c', creator: true, realModel: true, realSearchCredential: true, maintainerUpdate: true, nonMaintainerRejected: true, delegatedSkillCredential: true, minimal: true, cleanup: true })
}, 1800000)
