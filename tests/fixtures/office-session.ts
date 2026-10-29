import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBootstrapCredential } from '../../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../../src/adapters/community-runtime-driver.js'
import { createCommunityApplication } from '../../src/composition/community-application.js'
import { effectiveUserDataRoot } from '../../src/domain/storage-layout.js'
import { openCommunityHttpEntry } from '../support/community-http-entry.js'
import { communityEntryUrl } from '../support/community-space.js'
import { runtimeSettings } from '../support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from '../support/real-dsh-runtime.js'

export interface OfficeFactsInput {
  readonly root: string
  readonly runId: string
  readonly skillRoot: string
  readonly requirementsLock: string
  readonly imageResumeReport?: string
  readonly credentialFile: string
  readonly imageBackend: { readonly backend: 'volcengine' | 'minimax'; readonly baseUrl: string; readonly model: string }
  readonly sdkManifest: string
  readonly sdkRoot: string
  readonly onlyofficeVersion: string
  readonly onlyofficeIntegrity: string
}
export async function officeFactsInput(): Promise<OfficeFactsInput> {
  const path = process.env.DSH_PHALANX_OFFICE_FACTS_INPUT
  assert(path, 'Pass the private input JSON path explicitly; this manual probe never skips missing inputs')
  const input = JSON.parse(await readFile(path, 'utf8')) as OfficeFactsInput
  const owner = JSON.parse(await readFile(join(input.root, 'OWNER.json'), 'utf8')) as { runId: string; uid: number }
  assert(owner.runId === input.runId && owner.uid === process.getuid!(), 'Probe root owner mismatch')
  assertPinnedDshRevision(runtimeSettings)
  assert(runtimeSettings.containerImage, 'Run on the actual native user-instance image')
  return input
}
export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 180_000): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (done(value)) return value
    assert(Date.now() < deadline, 'Facts probe readiness deadline exceeded')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map(value => value.split(';')[0])
    .join('; ')

/** Uses the existing management HTTP, member entry and official DSH test observer seams. */
export async function openOfficeSession<Input extends Pick<OfficeFactsInput, 'root'>>(input: Input, catalogAddress?: string, hostLogPrefix?: string) {
  const root = join(input.root, 'application')
  const originalObserver = await readFile(fileURLToPath(new URL('./skill-observer.mjs', import.meta.url)), 'utf8')
  // Export only the requested Host log prefix through the public logger service.
  const observer = hostLogPrefix
    ? originalObserver.replace(
        'export function apply(ctx) {',
        'export function apply(ctx) { ctx.logger.exporter({ colors: false, levels: { default: 2 }, export(message) { for (const arg of message.args) if (typeof arg === "string" && arg.startsWith(' +
          JSON.stringify(hostLogPrefix) +
          ')) console.log(arg) } });',
      )
    : originalObserver
  // Only this owned observation envelope outlives the broker's unchanged 120-second limit.
  assert([...observer.matchAll(/AbortSignal.timeout\(20000\)/gu)].length === 1, 'Regular observer timeout template changed')
  const overlay = join(input.root, 'observer.json')
  await writeFile(
    overlay,
    JSON.stringify([{ id: 'tools', config: { mode: 'native' } }, { insert: [{ id: 'office-observer', name: '/dsh-phalanx/home/observer.mjs' }] }]),
  )
  const base = runtimeSection(root, 'https://example.test', runtimeSettings)
  const runtime = { ...base, environment: { ...base.environment, TMPDIR: '/tmp' }, patches: [overlay] }
  const inventory = process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES
  assert(runtimeSettings.containerImage === undefined || inventory?.trim(), 'Provide the measured validation host public IPv4 inventory for member networking')
  const app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    ...(inventory ? { network: { hostPublicAddresses: inventory.split(',').map(value => value.trim()) } } : {}),
    runtime,
    ...(catalogAddress ? { suiteCatalog: { address: catalogAddress } } : {}),
    downloadSources: { preset: process.env.DSH_PHALANX_VALIDATION_DOWNLOAD_SOURCE === 'mainland' ? 'mainland' : 'official', overrides: {} },
  })
  try {
    const origin = await app.start()
    await mkdir(join(effectiveUserDataRoot({ dataRoot: root }), 'member/home'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(effectiveUserDataRoot({ dataRoot: root }), 'member/home/observer.mjs'),
      observer.replace('AbortSignal.timeout(20000)', 'AbortSignal.timeout(150000)'),
    )
    const login = async (username: string) =>
      fetch(origin + '/login', {
        method: 'POST',
        redirect: 'manual',
        headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username, password: 'office-facts-fixture-password' }),
      })
    const credential = readBootstrapCredential(root)
    let response: Response
    if (credential) {
      response = await fetch(origin + '/bootstrap', {
        method: 'POST',
        redirect: 'manual',
        headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ credential: credential.credential, username: 'admin', password: 'office-facts-fixture-password' }),
      })
    } else response = await login('admin')
    assert(response.status === 303, 'Administrator initialization failed')
    const adminCookie = cookies(response)
    const request = async (path: string, cookie: string, input?: unknown) => {
      const response = await fetch(origin + path, {
        method: input === undefined ? 'GET' : 'POST',
        headers: { origin, cookie, 'content-type': 'application/json' },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      })
      assert(response.status < 300, `Facts probe HTTP ${response.status}: ${path}`)
      return response.json()
    }
    const api = (path: string, body?: unknown) => request('/admin/api/' + path, adminCookie, body)
    const groups = await api('groups')
    const group = groups.find((row: { isDefault: boolean }) => row.isDefault)
    assert(group, 'Missing default group')
    const accounts = await api('accounts')
    if (!accounts.items.some((row: { username: string }) => row.username === 'member')) {
      await api('accounts', { username: 'member', email: '', password: 'office-facts-fixture-password', groupId: group.id })
    }
    const enter = async (username = 'member') => {
      const response = await login(username)
      assert(response.status === 303 && response.headers.get('location') !== '/recovery', 'Member could not enter DSH')
      return (await openCommunityHttpEntry(origin, cookies(response), 300_000)).cookie
    }
    const memberCookies = new Map<string, string>()
    const observe = async (body: object, username = 'member') => {
      let memberCookie = memberCookies.get(username)
      if (!memberCookie) {
        memberCookie = await enter(username)
        memberCookies.set(username, memberCookie)
      }
      return request(new URL(communityEntryUrl(origin, memberCookie) + 'skills-fixture').pathname, memberCookie, body)
    }
    const bash = async (command: string, timeoutMs = 120_000, username = 'member') => {
      const { sessionId } = await observe({ operation: 'create' }, username)
      const result = await observe({ operation: 'tool', sessionId, name: 'bash', args: { description: 'Office facts probe', command, timeoutMs } }, username)
      assert(result.value, 'DSH tool observation failed: ' + JSON.stringify(result))
      if (result.value.kind !== 'promoted') return result.value
      const collected = await observe(
        { operation: 'tool', sessionId, name: 'job_output', args: { job_id: result.value.jobId, wait: true, timeout_ms: 30_000 } },
        username,
      )
      assert(
        collected.value?.job && !['running', 'stopping'].includes(collected.value.job.status),
        'Promoted command did not settle within its observation envelope',
      )
      const code = /exit code:\s*(-?\d+)/u.exec((collected.value.job.detail ?? '') + '\n' + collected.value.text)
      assert(code, 'Promoted command did not report an explicit terminal exit code: ' + JSON.stringify(collected.value.job))
      return {
        kind: 'collected-job',
        exitCode: Number(code[1]),
        stdout: { text: result.value.output + '\n' + collected.value.text },
        stderr: { text: '' },
        promoted: result.value,
        collected: collected.value,
      }
    }
    return {
      input,
      root,
      runtime,
      origin,
      adminCookie,
      api,
      request,
      enter,
      login,
      observe,
      bash,
      group,
      async stop() {
        try {
          await app.stop()
        } finally {
          await new CommunityRuntimeDriver(runtime).rebuild()
        }
      },
    }
  } catch (error) {
    await app.stop()
    throw error
  }
}
export type OfficeSession = Awaited<ReturnType<typeof openOfficeSession>>
