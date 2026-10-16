// Validation: T4 isolated host; real credentials: SSH access to the owned validation VM; no provider key. Never run on a live deployment.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { signInCommunity, selectCommunityWorkspace, runCommunityTerminal, sendCommunityTerminal } from './fixtures/community-native-browser.js'
import { defaultWorkspacePath, instanceWorkspacePath } from './support/real-dsh-runtime.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { acceptanceProgress } from './support/acceptance-progress.js'

let browser: Browser | undefined, model: Awaited<ReturnType<typeof startCommunityModel>> | undefined
let scratch: string | undefined
let relay: { host: string; directory: string; socket: string } | undefined
afterEach(async test => {
  await saveBrowserEvidence(test)
  model?.release(); await browser?.close(); await model?.close()
  if (relay !== undefined) {
    spawnSync('ssh', ['-S', relay.socket, '-O', 'exit', relay.host])
    await rm(relay.directory, { recursive: true, force: true })
  }
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  browser = undefined; model = undefined; scratch = undefined; relay = undefined
})

function ssh(command: string, input?: string) {
  const key = process.env.DSH_PHALANX_INSTALL_VM_KEY, known = process.env.DSH_PHALANX_INSTALL_VM_KNOWN_HOSTS
  const port = process.env.DSH_PHALANX_INSTALL_VM_SSH_PORT
  if (key === undefined || known === undefined || port === undefined) throw new Error('Requires a dedicated clean Ubuntu amd64 VM and recorded SSH identity')
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('ssh', ['-i', key, '-p', port, '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${known}`,
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'validator@127.0.0.1', `cd / && ${command}`], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += String(data) }); child.stderr.on('data', data => { stderr += String(data) })
    child.stdin.on('error', () => {})
    child.once('error', reject); child.once('close', code => { resolve({ code, stdout, stderr }) })
    child.stdin.end(input)
  })
}

async function successful(command: string, input?: string) {
  const result = await ssh(command, input)
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
}

// Include prerequisite installation, offline image import and reboot on software-emulated VMs.
// Functional readiness assertions inside the test retain their own bounded waits.
it('installs a verified candidate on clean Ubuntu, preserves user data across retry, and starts after an actual VM reboot', async () => {
  const tag = process.env.DSH_PHALANX_INSTALL_CANDIDATE
  const expectedSha = process.env.DSH_PHALANX_CANDIDATE_SHA
  const expectedDigest = process.env.DSH_PHALANX_INSTALL_IMAGE_DIGEST
  const expectedPlatform = process.env.DSH_PHALANX_INSTALL_PLATFORM_SHA256
  const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  if (tag === undefined || !/^run-[1-9]\d*$/u.test(tag) || expectedSha === undefined || expectedDigest === undefined || expectedPlatform === undefined || evidence === undefined) {
    throw new Error('Record exact candidate SHA/digest and private evidence directory before installed-VM acceptance')
  }
  const targetVersion = (JSON.parse(await readFile('package.json', 'utf8')) as { version: string }).version
  const manifest = JSON.parse(await successful('cat /mnt/candidate/manifest.json'))
  expect(manifest).toMatchObject({ schema: 2, tag, targetVersion, commit: expectedSha, runId: tag.slice(4), platform: 'linux/amd64', image: { digest: expectedDigest }, files: { 'dsh-phalanx-linux-amd64.tar.gz': expectedPlatform } })
  const origin = new URL(process.env.DSH_PHALANX_INSTALL_ORIGIN ?? 'http://127.0.0.1:18080').origin
  if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin)) throw new Error('Requires an explicit local forwarded VM origin')
  scratch = await mkdtemp(join(tmpdir(), 'dsh-phalanx-install-browser-'))
  const progress = await acceptanceProgress(process.env.DSH_PHALANX_ACCEPTANCE_PROGRESS ?? join(evidence, 'installer-progress.json'),
    { candidate: expectedSha, tag, image: expectedDigest, platform: expectedPlatform,
      host: (await successful('cat /etc/machine-id')).trim() },
    ['clean-host', 'fixture', 'install', 'accounts', 'empty-model', 'configure-model', 'native-before', 'retry', 'reboot', 'native-after'],
    process.env.DSH_PHALANX_ACCEPTANCE_RESUME)
  const dataMount = await progress.step('clean-host', async () => {
    await successful('set -e; for tool in node pnpm podman pasta newuidmap; do if command -v "$tool"; then exit 1; fi; done; for path in /opt/dsh-phalanx /var/lib/dsh-phalanx /etc/dsh-phalanx; do sudo -n test ! -e "$path"; done')
    const dataMount = JSON.parse(await successful('findmnt --json --mountpoint /mnt/data --output TARGET,SOURCE,UUID'))
    const dataDisk = dataMount.filesystems[0] as { target: string; source: string; uuid: string }
    expect(dataDisk.target).toBe('/mnt/data')
    expect(dataDisk.uuid).toMatch(/^[a-f0-9-]{36}$/u)
    expect(dataDisk.source).not.toBe((await successful('findmnt --noheadings --output SOURCE /')).trim())
    return dataMount
  })
  const dataDisk = dataMount.filesystems[0] as { target: string; source: string; uuid: string }
  model = await startCommunityModel(progress.saved<{ port: number }>('fixture')?.port)
  await progress.step('fixture', async () => ({ port: Number(new URL(model!.origin).port) }))
  const relayHost = process.env.DSH_PHALANX_INSTALL_MODEL_RELAY_HOST
  if (relayHost !== undefined) {
    const directory = await mkdtemp('/tmp/dsh-p11-relay-')
    relay = { host: relayHost, directory, socket: join(directory, 'control') }
    const port = new URL(model.origin).port
    const result = spawnSync('ssh', ['-M', '-S', relay.socket, '-f', '-N', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-R', `127.0.0.1:${port}:127.0.0.1:${port}`, relay.host], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
  }
  const guestModel = model.origin.replace('127.0.0.1', '10.0.2.2')
  const installerSource = await readFile('install.sh', 'utf8')
  await successful('sudo -n tee /var/tmp/dsh-phalanx-install.sh >/dev/null', installerSource)
  const proxy = process.env.DSH_PHALANX_INSTALL_HTTPS_PROXY
  if (proxy !== undefined && !/^https?:\/\/[a-zA-Z0-9.-]+:\d+$/u.test(proxy)) throw new Error('Use an explicit credential-free validation proxy origin')
  const network = proxy === undefined ? '' : `env HTTPS_PROXY='${proxy}' NO_PROXY='localhost,127.0.0.1,10.0.2.2' `
  const transfer = proxy === undefined ? '--bundle-dir /mnt/candidate' : '--download-source-preset mainland --dev-release-base-url https://github.com/dake6767/dsh-phalanx-candidates/releases'
  const command = `sudo -n ${network}bash /var/tmp/dsh-phalanx-install.sh --output json --version ${tag} ${transfer} --model-base-url ${guestModel} --host-public-addresses '' --listen-address 0.0.0.0 --port 18080 --public-origin ${origin} --user-data-root /mnt/data/dsh-phalanx-users --user-data-mount /mnt/data`
  const { installed, originalConfig, originalBoot } = await progress.step('install', async () => {
    console.log('installer: first command starting on recorded clean VM')
    const installed = JSON.parse(await successful(command)) as { status: string; commit: string; imageDigest: string; platformSha256: string; changed: boolean }
    expect(installed).toMatchObject({ status: 'installed', commit: expectedSha, imageDigest: expectedDigest, platformSha256: expectedPlatform, changed: true })
    console.log('installer: service ready; native browser bootstrap/model starting')
    const originalConfig = await successful('sudo -n sha256sum /etc/dsh-phalanx/environment')
    const originalBoot = (await successful('cat /proc/sys/kernel/random/boot_id')).trim()
    return { installed: { status: installed.status, commit: installed.commit, imageDigest: installed.imageDigest,
      platformSha256: installed.platformSha256, changed: installed.changed }, originalConfig, originalBoot }
  })
  browser = await chromium.launch({ headless: true })
  const adminContext = await newValidationContext(browser), admin = await adminContext.newPage()
  await progress.step('accounts', async () => {
    await writeFile(join(scratch!, 'bootstrap-credential'), await successful('sudo -n cat /var/lib/dsh-phalanx/data/bootstrap-credential'), { mode: 0o600 })
    const credential = readBootstrapCredential(scratch!)!.credential
    await admin.goto(`${origin}/bootstrap#credential=${encodeURIComponent(credential)}`)
    await admin.getByLabel('Username').fill('installer-admin')
    await admin.getByLabel('Password', { exact: true }).fill('installer-admin-password')
    await admin.getByRole('button', { name: 'Create administrator' }).click()
    await admin.waitForURL(`${origin}/admin`)
    await admin.getByRole('heading', { name: 'Account management' }).waitFor()
    expect((await adminContext.request.post(`${origin}/admin/api/accounts`, { headers: { origin },
      data: { username: 'installer-member', email: 'member@example.test', password: 'installer-member-password' } })).status()).toBe(201)
    return null
  })
  const loginAdmin = async () => {
    expect((await adminContext.request.post(`${origin}/login`, { headers: { origin },
      form: { username: 'installer-admin', password: 'installer-admin-password' }, maxRedirects: 0 })).status()).toBe(303)
  }
  let memberContext = await newValidationContext(browser), member = await memberContext.newPage()
  const enter = async () => {
    await signInCommunity(member, origin, 'installer-member', 'installer-member-password')
    await selectCommunityWorkspace(memberContext, member, origin, instanceWorkspacePath(defaultWorkspacePath('/var/lib/dsh-phalanx/data', 'installer-member'), true), true)
  }
  const stream = async () => {
    const replies = member.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' })
    const before = await replies.count()
    const composer = member.locator('[data-composer-input]')
    await composer.fill('STREAM_MODEL_TASK: Reply with the deterministic marker.'); await composer.press('Enter')
    await member.getByText('COMMUNITY_', { exact: true }).waitFor({ timeout: 90_000 })
    model!.release()
    await expect.poll(() => replies.count(), { timeout: 90_000 }).toBe(before + 1)
    expect(await member.content()).not.toContain('community-provider-fixture-key')
  }
  await progress.step('empty-model', async () => {
    await loginAdmin(); await enter()
    await runCommunityTerminal(member, "if [ \"$(id -u)\" != 0 ] && [ -z \"${DSH_PHALANX_MODEL_UPSTREAM_API_KEY-}\" ]; then printf 'ROOTLESS_%s' 'SECRET_ABSENT'; fi", 'ROOTLESS_SECRET_ABSENT')
    await sendCommunityTerminal(member, "printf '%s' 'INSTALLER_USER_FILE' > installer-notes.txt; if [ \"$(cat installer-notes.txt)\" = 'INSTALLER_USER_FILE' ]; then printf 'INSTALL_%s' 'READY'; fi", 'INSTALL_READY')
    expect(await (await adminContext.request.get(`${origin}/admin/api/models`)).json()).toMatchObject({ providers: [] })
    await member.locator('[data-composer-input]').fill('NO_MODEL_TASK'); await member.locator('[data-composer-input]').press('Enter')
    // Native DSH retries the expected 503 before showing the final unconfigured-model error.
    await member.getByText(/Shared models are not configured/u).filter({ visible: true }).first().waitFor({ timeout: 90_000 })
    return null
  })
  await progress.step('configure-model', async () => {
    await loginAdmin(); await enter()
    const configured = await adminContext.request.post(`${origin}/admin/api/models`, { headers: { origin }, data: {
      revision: 0, action: 'save-provider', provider: { name: 'Installer controlled model', baseUrl: `${guestModel}/anthropic`,
        apiFormat: 'anthropic-messages', apiKey: 'community-provider-fixture-key', enabled: true, models: [{ name: 'deepseek-chat', enabled: true }] },
    } })
    expect(configured.status()).toBe(200)
    const rpc = createBrowserDshRpc(memberContext)
    const cookie = await cookieHeader(memberContext, origin)
    await expect.poll(async () => JSON.stringify(await rpc.remoteRpc(origin, cookie, 'session/modelCatalog', {})), { timeout: 30_000 }).toContain('Installer controlled model')
    return null
  })
  await progress.step('native-before', async () => {
    await enter()
    // The failed session retains its unconfigured request header. A new native
    // session proves that the newly configured administrator default is usable.
    await member.getByRole('button', { name: /^New session$/iu }).first().click()
    await member.getByRole('button', { name: /deepseek-chat/u }).waitFor({ timeout: 30_000 })
    await stream()
    return null
  })
  const { repeated, corruptCandidateExit } = await progress.step('retry', async () => {
    await enter()
    console.log('installer: repeat and controlled checksum failure')
    const repeated = JSON.parse(await successful(command)) as { changed: boolean }
    expect(repeated.changed).toBe(false)
    expect(await successful('sudo -n sha256sum /etc/dsh-phalanx/environment')).toBe(originalConfig)
    await successful("sudo -n sh -c 'mkdir -p /var/tmp/dsh-phalanx-corrupt; cp /mnt/candidate/manifest.json /mnt/candidate/SHA256SUMS /var/tmp/dsh-phalanx-corrupt/; printf broken > /var/tmp/dsh-phalanx-corrupt/dsh-phalanx-linux-amd64.tar.gz'")
    const rejected = await ssh(command.replace(transfer, '--bundle-dir /var/tmp/dsh-phalanx-corrupt'))
    expect(rejected.code).toBe(1)
    expect(await successful('sudo -n sha256sum /etc/dsh-phalanx/environment')).toBe(originalConfig)
    expect((JSON.parse(await successful(command)) as { changed: boolean }).changed).toBe(false)
    // The configured-model session has its own terminal tabs.
    await runCommunityTerminal(member, "if [ \"$(cat installer-notes.txt)\" = 'INSTALLER_USER_FILE' ]; then printf 'RETRY_%s' 'PRESERVED'; fi", 'RETRY_PRESERVED')
    return { repeated, corruptCandidateExit: rejected.code }
  })
  const newBoot = await progress.step('reboot', async () => {
    console.log('installer: actual VM reboot starting')
    if ((await successful('cat /proc/sys/kernel/random/boot_id')).trim() === originalBoot) {
      const reboot = await ssh('sudo -n systemctl reboot')
      expect([0, 255]).toContain(reboot.code)
    }
    let newBoot = originalBoot
    await expect.poll(async () => {
      const result = await ssh('cat /proc/sys/kernel/random/boot_id')
      if (result.code !== 0) return false
      newBoot = result.stdout.trim()
      return newBoot !== originalBoot
    }, { timeout: 600_000, interval: 1000 }).toBe(true)
    await expect.poll(async () => { try { return (await fetch(`${origin}/login`)).status } catch { return 0 } }, { timeout: 90_000 }).toBe(200)
    expect(await successful('sudo -n sha256sum /etc/dsh-phalanx/environment')).toBe(originalConfig)
    return newBoot
  })
  await progress.step('native-after', async () => {
    // A fresh browser proves persisted server state independently of stale native terminal tabs.
    await memberContext.close()
    memberContext = await newValidationContext(browser!); member = await memberContext.newPage()
    await enter()
    await runCommunityTerminal(member, "if [ \"$(cat installer-notes.txt)\" = 'INSTALLER_USER_FILE' ]; then printf 'BOOT_%s' 'PRESERVED'; fi", 'BOOT_PRESERVED')
    expect(JSON.parse(await successful('findmnt --json --mountpoint /mnt/data --output TARGET,SOURCE,UUID'))).toEqual(dataMount)
    const storedFiles = (await successful('sudo -n find /mnt/data/dsh-phalanx-users -type f -name installer-notes.txt')).trim().split('\n')
    expect(storedFiles).toHaveLength(1)
    expect(storedFiles[0]).toMatch(/^\/mnt\/data\/dsh-phalanx-users\/(?:[a-z0-9][a-z0-9_-]{0,63}|_spaces\/[a-f0-9]{32})\/home\/Documents\/deepseek-harness\/default-workspace\/installer-notes\.txt$/u)
    expect((await successful(`sudo -n cat ${storedFiles[0]}`)).trim()).toBe('INSTALLER_USER_FILE')
    await stream()
    const service = await successful("sudo -n -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user is-enabled dsh-phalanx.service; sudo -n -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user is-active dsh-phalanx.service")
    expect(service.trim().split('\n')).toEqual(['enabled', 'active'])
    const namespaceRestriction = (await successful('cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns')).trim()
    expect(namespaceRestriction).toBe('1')
    await mkdir(evidence, { recursive: true, mode: 0o700 })
    await writeFile(join(evidence, 'installer-result.json'), JSON.stringify({ status: 'passed', installed, repeated, resume: progress.report(),
      installerSha256: createHash('sha256').update(installerSource).digest('hex'),
      corruptCandidateExit, originalConfigSha256: originalConfig.trim().split(' ')[0], originalBoot, newBoot,
      rebooted: true, service: ['enabled', 'active'], apparmorUserNamespaceRestriction: 1, independentUserDataDisk: dataDisk,
      initialModelSupply: 'empty', defaultModel: 'real DSH native streaming via controlled upstream', nativeIdentity: 'non-root, provider secret absent', userFile: 'preserved across repeat/failure/reboot' }, null, 2)+'\n', { mode: 0o600 })
    return null
  })
  await progress.finish()
  console.log('installer: native model, retry, persistence and reboot passed')
}, 5_400_000)
