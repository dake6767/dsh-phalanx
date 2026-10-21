// Validation: T2; real credentials: none; installed rootless DSH, browser controls and independent kernel cgroup observations.
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import type { CommunityInstanceResourceApplication, CommunityInstanceResourceMember, CommunityInstanceResourceSettings } from '../src/domain/admin-contract.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { signInCommunity } from './fixtures/community-native-browser.js'

let root: string | undefined, app: CommunityApplication | undefined, browser: Browser | undefined, runtime: CommunityRuntimeConfig | undefined
afterEach(async test => {
  const errors: unknown[] = []
  let rebuilt = false
  for (const action of [() => saveBrowserEvidence(test), () => browser?.close(), () => app?.stop(), async () => { if (runtime) await new CommunityRuntimeDriver(runtime).rebuild(); rebuilt = true }, async () => { if (root && rebuilt) await rm(root, { recursive: true, force: true }) }]) {
    try { await action() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'Member resource acceptance cleanup failed')
})

it('applies defaults and overrides to real member cgroups, restores unlimited limits and observes a kernel OOM', async () => {
  if (process.platform !== 'linux' || process.getuid?.() === 0 || !runtimeSettings.containerImage) throw new Error('Actual rootless Linux DSH is required')
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'member-resources-'))
  runtime = runtimeSection(root, 'http://127.0.0.1:1', runtimeSettings)
  const config = { listen: { host: '127.0.0.1', port: 0 }, idleReclaimSeconds: 0, sessionSecret: 'member-resources-native-secret-at-least-32-bytes', runtime }
  app = candidateApplication(config)
  let origin = await app.start()
  browser = await chromium.launch({ headless: true })
  const adminContext = await newValidationContext(browser, { locale: 'en' }), admin = await adminContext.newPage()
  await admin.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await admin.getByLabel('Username', { exact: true }).fill('admin'); await admin.getByLabel('Password', { exact: true }).fill('password')
  await admin.getByRole('button', { name: 'Create administrator', exact: true }).click(); await admin.waitForURL(`${origin}/admin`)
  expect((await adminContext.request.post(origin + '/admin/api/accounts', { headers: { origin }, data: { username: 'member', email: 'member@example.test', password: 'password' } })).status()).toBe(201)
  const endpoint = () => origin + '/admin/api/instance-resources'
  const member = async () => (await (await adminContext.request.get(endpoint() + '?username=member')).json()) as CommunityInstanceResourceMember
  const initialSettings = await (await adminContext.request.get(endpoint())).json() as CommunityInstanceResourceSettings
  expect(initialSettings.defaults).toEqual({ cpus: null, memoryMiB: null, pids: null })
  // Limits are ceilings, not reservations: overcommit must warn without blocking this idle instance.
  const startupMemoryMiB = Math.ceil(initialSettings.host.memoryMiB) + 1024
  await admin.getByRole('link', { name: 'System settings', exact: true }).click()
  const defaults = admin.getByRole('region', { name: 'Member instances', exact: true })
  await defaults.getByLabel('CPU (cores)', { exact: true }).fill('0.5')
  await defaults.getByLabel('Memory (MiB)', { exact: true }).fill(String(startupMemoryMiB))
  await defaults.getByLabel('Processes', { exact: true }).fill('256')
  await defaults.getByRole('button', { name: 'Save instance limits', exact: true }).click()
  await defaults.getByRole('status').filter({ hasText: 'Instance limits saved.' }).waitFor()

  const memberContext = await newValidationContext(browser, { locale: 'en' }), memberPage = await memberContext.newPage()
  await signInCommunity(memberPage, origin, 'member', 'password')
  const ownership = createHash('sha256').update(root).digest('hex'), cli = runtimeSettings.containerRuntimeCli
  const carriers = () => execFileSync(cli, ['ps', '--filter', 'label=dsh-phalanx.community=1', '--filter', `label=dsh-phalanx.community-root=${ownership}`, '--filter', 'label=dsh-phalanx.user=member', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  const currentCarrier = () => { const names = carriers(); expect(names).toHaveLength(1); return names[0]! }
  const kernel = () => JSON.parse(execFileSync(cli, ['exec', currentCarrier(), 'node', '-e', "const fs=require('fs');console.log(JSON.stringify(Object.fromEntries(['cpu.max','memory.max','memory.swap.max','pids.max'].map(n=>[n,fs.readFileSync('/sys/fs/cgroup/'+n,'utf8').trim()]))))"], { encoding: 'utf8' })) as Record<string, string>
  const bounded = (cpu: number, memory: number, pids: number) => {
    const values = kernel(), [quota, period] = values['cpu.max']!.split(' ').map(Number)
    expect(quota! / period!).toBe(cpu); expect(values['memory.max']).toBe(String(memory * 1024 ** 2)); expect(values['memory.swap.max']).toBe('0'); expect(values['pids.max']).toBe(String(pids))
  }
  const unlimited = () => { const values = kernel(); expect(values['cpu.max']!.split(' ')[0]).toBe('max'); for (const key of ['memory.max', 'memory.swap.max', 'pids.max']) expect(values[key]).toBe('max') }
  bounded(0.5, startupMemoryMiB, 256)
  expect(await member()).toMatchObject({ source: 'default', pending: false, current: { cpus: 0.5, memoryMiB: startupMemoryMiB, pids: 256 } })
  await defaults.getByRole('button', { name: 'Reload instance limits', exact: true }).click()
  await defaults.getByText('Target memory limits exceed host memory. This warning does not block startup.', { exact: true }).waitFor()
  expect((await memberContext.request.get(endpoint())).status()).toBe(403)
  const first = currentCarrier()
  const edit = async () => { await admin.goto(origin + '/admin/accounts'); await admin.getByRole('button', { name: 'Edit member', exact: true }).click(); return admin.getByRole('dialog', { name: 'Edit account: member', exact: true }) }
  let drawer = await edit(), limits = drawer.getByRole('region', { name: 'Instance resource limits', exact: true })
  await limits.getByRole('button', { name: /Limit source/u }).click(); await admin.getByRole('option', { name: 'Custom limits', exact: true }).click()
  await limits.getByLabel('CPU (cores)', { exact: true }).fill('0.75'); await limits.getByLabel('Memory (MiB)', { exact: true }).fill('2048'); await limits.getByLabel('Processes', { exact: true }).fill('512')
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click(); await drawer.waitFor({ state: 'detached' })
  expect((await member()).pending).toBe(true); bounded(0.5, startupMemoryMiB, 256); expect(currentCarrier()).toBe(first)
  await admin.getByRole('row').filter({ hasText: 'member' }).getByText('Limits pending', { exact: true }).waitFor()
  await admin.getByRole('link', { name: 'System settings', exact: true }).click()
  await defaults.getByRole('button', { name: 'Apply to running instances (1)', exact: true }).click()
  let confirmation = admin.getByRole('dialog', { name: 'Apply resource limits?', exact: true })
  bounded(0.5, startupMemoryMiB, 256)
  await confirmation.getByRole('button', { name: 'Apply now', exact: true }).click()
  await defaults.getByRole('status').filter({ hasText: 'Instance limits applied.' }).waitFor()
  bounded(0.75, 2048, 512); expect(currentCarrier()).toBe(first)

  drawer = await edit(); limits = drawer.getByRole('region', { name: 'Instance resource limits', exact: true })
  await limits.getByLabel('Memory (MiB)', { exact: true }).fill('1536')
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click(); await drawer.waitFor({ state: 'detached' })
  drawer = await edit(); limits = drawer.getByRole('region', { name: 'Instance resource limits', exact: true })
  await limits.getByRole('button', { name: 'Apply immediately', exact: true }).click()
  confirmation = admin.getByRole('dialog', { name: 'Apply resource limits?', exact: true })
  await confirmation.getByText('Reducing memory may terminate running tasks.', { exact: true }).waitFor()
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click(); bounded(0.75, 2048, 512)
  await limits.getByRole('button', { name: 'Apply immediately', exact: true }).click(); await confirmation.getByRole('button', { name: 'Apply now', exact: true }).click()
  await expect.poll(async () => (await member()).pending).toBe(false)
  bounded(0.75, 1536, 512); expect(currentCarrier()).toBe(first)
  for (const label of ['CPU (cores)', 'Memory (MiB)', 'Processes']) await limits.getByLabel(label, { exact: true }).fill('')
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click(); await drawer.waitFor({ state: 'detached' })
  drawer = await edit(); limits = drawer.getByRole('region', { name: 'Instance resource limits', exact: true })
  await limits.getByRole('button', { name: 'Apply immediately', exact: true }).click()
  confirmation = admin.getByRole('dialog', { name: 'Apply resource limits?', exact: true })
  await confirmation.getByText('If live application is unavailable, the instance will restart and its tasks will be interrupted.', { exact: true }).waitFor()
  const applied = admin.waitForResponse(response => response.url() === endpoint() && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'apply')
  await confirmation.getByRole('button', { name: 'Apply now', exact: true }).click()
  const application = await (await applied).json() as CommunityInstanceResourceApplication
  expect(application.results[0]?.status).toBe('applied')
  const method = application.results[0]!.method
  expect(['updated', 'restarted']).toContain(method)
  if (method === 'restarted') expect(currentCarrier()).not.toBe(first)
  else expect(currentCarrier()).toBe(first)
  unlimited(); expect((await member()).pending).toBe(false)

  // A changed old deployment variable must not override the saved resource settings.
  await app.stop()
  runtime = { ...runtime, container: { ...runtime.container!, extraArgs: ['--memory', '256m', '--cpus', '0.25', '--pids-limit', '32'] } }
  app = candidateApplication({ ...config, runtime }); origin = await app.start()
  await signInCommunity(memberPage, origin, 'member', 'password')
  unlimited(); expect(await member()).toMatchObject({ source: 'custom', target: { cpus: null, memoryMiB: null, pids: null } })
  const beforeOom = await member()
  const saving = await adminContext.request.post(endpoint(), { headers: { origin }, data: { action: 'save-member', revision: beforeOom.revision, username: 'member', spaceId: beforeOom.spaceId, override: { cpus: 0.5, memoryMiB: 1536, pids: 256 } } })
  expect(saving.status()).toBe(200)
  const target = await saving.json() as CommunityInstanceResourceMember
  expect((await adminContext.request.post(endpoint(), { headers: { origin }, data: { action: 'apply', revision: target.revision, confirmed: true, targets: [{ username: target.username, spaceId: target.spaceId, instanceKey: target.instanceKey }] } })).status()).toBe(200)
  bounded(0.5, 1536, 256)
  const name = currentCarrier(), pid = Number(execFileSync(cli, ['inspect', '--format', '{{.State.Pid}}', name], { encoding: 'utf8' }).trim())
  const path = (await readFile(`/proc/${pid}/cgroup`, 'utf8')).split('\n').find(line => line.startsWith('0::'))!.slice(3)
  const events = join('/sys/fs/cgroup', path, 'memory.events'), kills = (text: string) => Number(/^oom_kill (\d+)$/mu.exec(text)?.[1] ?? 0)
  const initialKills = kills(await readFile(events, 'utf8'))
  let observedKills = initialKills, stopped = false
  const watch = (async () => { while (!stopped) { try { observedKills = Math.max(observedKills, kills(await readFile(events, 'utf8'))) } catch (error) { if (['ENOENT', 'ENODEV'].includes((error as NodeJS.ErrnoException).code ?? '')) break; throw error }; await sleep(2) } })()
  try {
    await new Promise<void>(resolve => { execFile(cli, ['exec', name, 'node', '-e', 'const held=[];setInterval(()=>{held.push(Buffer.alloc(16*1024*1024,1))},20)'], { timeout: 30_000 }, () => resolve()) })
    try { observedKills = Math.max(observedKills, kills(await readFile(events, 'utf8'))) } catch (error) { if (!['ENOENT', 'ENODEV'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
  } finally { stopped = true; await watch }
  expect(observedKills).toBeGreaterThan(initialKills)
  console.info('Member resource kernel evidence', { unlimitedApplication: method, initialOomKills: initialKills, observedOomKills: observedKills })
}, 600_000)
