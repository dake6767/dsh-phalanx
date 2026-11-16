// Validation: T4 manual; real credentials: none; recorded speech and pinned public model assets on native Linux.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import type { PlatformVoicePrecision, PlatformVoiceSettingsView } from '../src/domain/admin-contract.js'
import { nativeVoiceBundle, voiceMount } from '../src/dsh/native-voice.js'
import { voiceAssets } from '../src/dsh/voice-assets.js'
import { selectCommunityWorkspace, signInCommunity } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, defaultWorkspacePath, instanceWorkspacePath, runtimeSection } from './support/real-dsh-runtime.js'

it('transcribes recorded speech in native DSH and preserves the member’s Bundle preference', async () => {
  const audio = process.env.DSH_PHALANX_VOICE_E2E_AUDIO
  const expected = process.env.DSH_PHALANX_VOICE_E2E_EXPECT
  if (!audio || !expected) throw new Error('Provide a recording and its expected transcript excerpt')
  const precision: PlatformVoicePrecision = process.env.DSH_PHALANX_VOICE_E2E_PRECISION === 'fp32' ? 'fp32' : 'int8'
  if (
    process.env.DSH_PHALANX_VOICE_E2E_LOCAL !== '1' &&
    (process.platform !== 'linux' || !runtimeSettings.containerImage || !process.env.DSH_PHALANX_INSTALL_ROOT)
  )
    throw new Error('Specify a native Linux installed candidate and its rootless image')
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'community-voice-real-'))
  const stagedAssets = process.env.DSH_PHALANX_VOICE_E2E_ASSETS
  if (stagedAssets) {
    // The platform still verifies the complete cached blobs before publishing its mount.
    const blobs = join(root, 'platform-voice', 'blobs')
    await mkdir(blobs, { recursive: true, mode: 0o700 })
    for (const asset of [voiceAssets.tokens, voiceAssets.vad, voiceAssets.models[precision]]) {
      const target = join(blobs, asset.sha256)
      await copyFile(join(stagedAssets, asset.name), target)
      await chmod(target, 0o444)
    }
  }
  const runtime = runtimeSection(root, 'http://127.0.0.1:1', runtimeSettings)
  const app = candidateApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'community-voice-real-fixture-secret',
    runtime,
    downloadSources: { preset: process.env.DSH_PHALANX_VOICE_E2E_MIRROR === '1' ? 'mainland' : 'official' },
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const origin = await app.start()
    browser = await chromium.launch({
      headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + audio],
    })
    const administrator = await browser.newContext({ locale: 'en' })
    const bootstrap = await administrator.request.post(origin + '/bootstrap', {
      headers: { origin },
      form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' },
      maxRedirects: 0,
    })
    expect(bootstrap.status()).toBe(303)
    const api = async <T>(path: string, data?: object): Promise<T> => {
      const response = data
        ? await administrator.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
        : await administrator.request.get(origin + '/admin/api/' + path)
      expect(response.ok(), await response.text()).toBe(true)
      return (await response.json()) as T
    }
    const models = await api<{ revision: number }>('models')
    await api('models', {
      revision: models.revision,
      action: 'save-provider',
      provider: {
        name: 'Unused chat fixture',
        baseUrl: 'http://127.0.0.1:1/anthropic',
        apiFormat: 'anthropic-messages',
        apiKey: 'fictional-model-key',
        enabled: true,
        models: [{ name: 'deepseek-chat', enabled: true }],
      },
    })
    await api('accounts', { username: 'voice-member', email: '', password: 'password' })
    const get = () => api<PlatformVoiceSettingsView>('platform-voice')
    const save = async (enabled: boolean) => api<PlatformVoiceSettingsView>('platform-voice', { revision: (await get()).revision, enabled, precision })
    const member = await browser.newContext({ locale: 'en', permissions: ['microphone'] })
    const page = await member.newPage()
    await signInCommunity(page, origin, 'voice-member', 'password')
    const containerMode = 'container' in runtime
    const workspace = instanceWorkspacePath(await defaultWorkspacePath(root, 'voice-member'), containerMode)
    await selectCommunityWorkspace(member, page, origin, workspace, containerMode)
    const rpc = createBrowserDshRpc(member)
    const call = async <T>(endpoint: string, args: object) => rpc.remoteRpc<T>(origin, await cookieHeader(member, origin), endpoint, args)
    const bundles = () => call<{ name: string; enabled: boolean }[]>('pluginManager/listBundles', {})
    const enabled = async () => (await bundles()).find(row => row.name === nativeVoiceBundle)?.enabled === true
    const restart = async () => {
      const response = await member.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true }, timeout: 300_000 })
      expect(response.ok(), await response.text()).toBe(true)
      await page.reload()
      await selectCommunityWorkspace(member, page, origin, workspace, containerMode)
    }
    const assertMounts = (present: boolean) => {
      if (!containerMode) return
      const run = (args: string[]) => execFileSync(runtimeSettings.containerRuntimeCli, args, { encoding: 'utf8' })
      const ownership = createHash('sha256').update(root).digest('hex')
      const ids = run([
        'ps',
        '--filter',
        'label=dsh-phalanx.community-root=' + ownership,
        '--filter',
        'label=dsh-phalanx.user=voice-member',
        '--format',
        '{{.ID}}',
      ])
        .trim()
        .split('\n')
      expect(ids).toHaveLength(1)
      const mounts = JSON.parse(run(['inspect', '--format', '{{json .Mounts}}', ids[0]!])) as { Source: string; Destination: string; RW: boolean }[]
      const speech = mounts.filter(mount => mount.Destination.startsWith(voiceMount))
      if (!present) {
        expect(speech).toEqual([])
        return
      }
      expect(speech).toHaveLength(2)
      expect(speech).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Source: expect.stringContaining('/platform-voice/models/' + voiceAssets.models[precision].sha256),
            Destination: voiceMount + '/model',
            RW: false,
          }),
          expect.objectContaining({
            Source: expect.stringContaining('/platform-voice/blobs/' + voiceAssets.vad.sha256),
            Destination: voiceMount + '/silero_vad.onnx',
            RW: false,
          }),
        ]),
      )
    }
    const microphone = page.getByRole('button', { name: 'Start recording', exact: true })
    expect(await enabled()).toBe(false)
    assertMounts(false)
    await save(true)
    await expect.poll(async () => (await get()).status, { timeout: 3_600_000, interval: 2000 }).not.toBe('preparing')
    expect(await get()).toMatchObject({ status: 'ready', activePrecision: precision })
    expect(await enabled()).toBe(false)
    await restart()
    expect(await enabled()).toBe(true)
    assertMounts(true)
    const inventory = await call<{ moduleName: string; fiberPhase: string | null; enabled: boolean; diagnostic?: string }[]>('pluginManager/listPlugins', {})
    expect(
      inventory
        .filter(row => row.moduleName.includes('speech-to-text') || row.moduleName.includes('voice-input'))
        .map(row => [row.moduleName, row.enabled, row.fiberPhase, row.diagnostic]),
    ).toEqual(expect.arrayContaining([expect.arrayContaining(['@deepseek-ai/dsh-experimental-speech-to-text-sensevoice', true, 'active'])]))
    await expect
      .poll(
        async () => {
          const catalog = await call<{ providers: { id: string; preparation: { phase: string } }[] }>('speech/catalog', {})
          return catalog.providers.map(row => [row.id, row.preparation.phase])
        },
        { timeout: 30_000 },
      )
      .toEqual(expect.arrayContaining([['sensevoice-local', expect.stringMatching(/^(standby|ready)$/u)]]))
    await microphone.waitFor({ timeout: 30_000 })
    await microphone.click()
    const stop = page.getByRole('button', { name: 'Stop and transcribe', exact: true })
    await stop.waitFor()
    // Record enough of the real PCM file to exercise audio acquisition and inference.
    const audioBytes = (await stat(audio)).size
    await new Promise(resolve => setTimeout(resolve, Math.ceil((audioBytes - 44) / 32) + 400))
    await stop.click()
    const composer = page.locator('[data-composer-input]')
    const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    await expect.poll(async () => normalize(await composer.innerText()), { timeout: 120_000 }).toContain(normalize(expected))
    expect(await readFile(audio).then(data => data.subarray(0, 4).toString())).toBe('RIFF')
    await save(false)
    expect(await enabled()).toBe(true)
    assertMounts(true)
    await restart()
    expect(await enabled()).toBe(false)
    assertMounts(false)
    await save(true)
    await expect.poll(async () => (await get()).status, { timeout: 5_000 }).toBe('ready')
    await restart()
    expect(await enabled()).toBe(true)
    assertMounts(true)
    await call('pluginManager/setBundleEnabled', { name: nativeVoiceBundle, enabled: false })
    await restart()
    expect(await enabled()).toBe(false)
    expect(await microphone.count()).toBe(0)
    assertMounts(false)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(audio)) hash.update(chunk)
    console.info(
      JSON.stringify({
        arch: process.arch,
        precision,
        audioSha256: hash.digest('hex'),
        browserRecording: true,
        transcriptMatched: true,
        memberOptOutRetained: true,
      }),
    )
  } finally {
    await browser?.close()
    await app.stop()
    await new CommunityRuntimeDriver(runtime).rebuild()
    await removeCommunityFixture(root)
  }
}, 3_900_000)
