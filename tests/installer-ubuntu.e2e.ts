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
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'validator@127.0.0.1', command], { stdio: ['pipe', 'pipe', 'pipe'] })
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

it('installs a verified candidate on clean Ubuntu, preserves user data across retry, and starts after an actual VM reboot', async () => {
  const tag = process.env.DSH_PHALANX_INSTALL_CANDIDATE
  const expectedSha = process.env.DSH_PHALANX_CANDIDATE_SHA
  const expectedDigest = process.env.DSH_PHALANX_INSTALL_IMAGE_DIGEST
  const expectedPlatform = process.env.DSH_PHALANX_INSTALL_PLATFORM_SHA256
  const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  if (tag === undefined || !/^v0\.1\.[01]-rc\.[1-9]\d*$/u.test(tag) || expectedSha === undefined || expectedDigest === undefined || expectedPlatform === undefined || evidence === undefined) {
    throw new Error('Record exact candidate SHA/digest and private evidence directory before installed-VM acceptance')
  }
  const withoutInitialModel = tag.startsWith('v0.1.1-')
  scratch = await mkdtemp(join(tmpdir(), 'dsh-phalanx-install-browser-'))
  await successful('set -e; for tool in node pnpm podman pasta newuidmap; do if command -v "$tool"; then exit 1; fi; done; for path in /opt/dsh-phalanx /var/lib/dsh-phalanx /etc/dsh-phalanx; do sudo -n test ! -e "$path"; done')
  model = await startCommunityModel()
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
  await successful('sudo -n sh -c "umask 077; cat > /var/tmp/dsh-phalanx-model-key"', 'community-provider-fixture-key')
  const command = `sudo -n bash /var/tmp/dsh-phalanx-install.sh --version ${tag} --bundle-dir /mnt/candidate ${withoutInitialModel ? '' : '--model-key-file /var/tmp/dsh-phalanx-model-key'} --model-base-url ${guestModel} --host-public-addresses '' --listen-address 0.0.0.0 --port 18080 --public-origin http://127.0.0.1:18080`
  console.log('installer: first command starting on recorded clean VM')
  const installed = JSON.parse(await successful(command)) as { status: string; commit: string; imageDigest: string; platformSha256: string; changed: boolean }
  expect(installed).toMatchObject({ status: 'installed', commit: expectedSha, imageDigest: expectedDigest, platformSha256: expectedPlatform, changed: true })
  console.log('installer: service ready; native browser bootstrap/model starting')
  const originalConfig = await successful('sudo -n sha256sum /etc/dsh-phalanx/environment')
  const originalBoot = (await successful('cat /proc/sys/kernel/random/boot_id')).trim()
  await writeFile(join(scratch, 'bootstrap-credential'), await successful('sudo -n cat /var/lib/dsh-phalanx/data/bootstrap-credential'), { mode: 0o600 })
  const credential = readBootstrapCredential(scratch)!.credential
  const origin = 'http://127.0.0.1:18080'
  browser = await chromium.launch({ headless: true })
  const adminContext = await newValidationContext(browser), admin = await adminContext.newPage()
  await admin.goto(`${origin}/bootstrap#credential=${encodeURIComponent(credential)}`)
  await admin.getByLabel('Username').fill('installer-admin')
  await admin.getByLabel('Password', { exact: true }).fill('installer-admin-password')
  await admin.getByRole('button', { name: 'Create administrator' }).click()
  await admin.waitForURL(`${origin}/admin`)
  await admin.getByRole('heading', { name: 'Account management' }).waitFor()
  expect((await adminContext.request.post(`${origin}/admin/api/accounts`, { headers: { origin },
    data: { username: 'installer-member', email: 'member@example.test', password: 'installer-member-password' } })).status()).toBe(201)
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
  await enter()
  await runCommunityTerminal(member, "if [ \"$(id -u)\" != 0 ] && [ -z \"${DSH_PHALANX_MODEL_UPSTREAM_API_KEY-}\" ]; then printf 'ROOTLESS_%s' 'SECRET_ABSENT'; fi", 'ROOTLESS_SECRET_ABSENT')
  await sendCommunityTerminal(member, "printf '%s' 'INSTALLER_USER_FILE' > installer-notes.txt; if [ \"$(cat installer-notes.txt)\" = 'INSTALLER_USER_FILE' ]; then printf 'INSTALL_%s' 'READY'; fi", 'INSTALL_READY')
  if (withoutInitialModel) {
    expect(await (await adminContext.request.get(`${origin}/admin/api/models`)).json()).toMatchObject({ providers: [] })
    await member.locator('[data-composer-input]').fill('NO_MODEL_TASK'); await member.locator('[data-composer-input]').press('Enter')
    await member.getByText(/Shared models are not configured/u).filter({ visible: true }).first().waitFor({ timeout: 30_000 })
    const configured = await adminContext.request.post(`${origin}/admin/api/models`, { headers: { origin }, data: {
      revision: 0, action: 'save-provider', provider: { name: 'Installer controlled model', baseUrl: `${guestModel}/anthropic`,
        apiFormat: 'anthropic-messages', apiKey: 'community-provider-fixture-key', enabled: true, models: [{ name: 'deepseek-chat', enabled: true }] },
    } })
    expect(configured.status()).toBe(200)
    const rpc = createBrowserDshRpc(memberContext)
    const cookie = await cookieHeader(memberContext, origin)
    await expect.poll(async () => JSON.stringify(await rpc.remoteRpc(origin, cookie, 'session/modelCatalog', {})), { timeout: 30_000 }).toContain('Installer controlled model')
    // The failed session retains its unconfigured request header. A new native
    // session proves that the newly configured administrator default is usable.
    await member.getByRole('button', { name: /^New session$/iu }).first().click()
    await member.getByRole('button', { name: /deepseek-chat/u }).waitFor({ timeout: 30_000 })
  }
  await stream()
  console.log('installer: repeat and controlled checksum failure')
  const repeated = JSON.parse(await successful(command)) as { changed: boolean }
  expect(repeated.changed).toBe(false)
  expect(await successful('sudo -n sha256sum /etc/dsh-phalanx/environment')).toBe(originalConfig)
  await successful("sudo -n sh -c 'mkdir -p /var/tmp/dsh-phalanx-corrupt; cp /mnt/candidate/manifest.json /mnt/candidate/SHA256SUMS /var/tmp/dsh-phalanx-corrupt/; printf broken > /var/tmp/dsh-phalanx-corrupt/dsh-phalanx-linux-amd64.tar.gz'")
  const rejected = await ssh(command.replace('/mnt/candidate', '/var/tmp/dsh-phalanx-corrupt'))
  expect(rejected.code).toBe(1)
  expect(await successful('sudo -n sha256sum /etc/dsh-phalanx/environment')).toBe(originalConfig)
  expect((JSON.parse(await successful(command)) as { changed: boolean }).changed).toBe(false)
  await sendCommunityTerminal(member, "if [ \"$(cat installer-notes.txt)\" = 'INSTALLER_USER_FILE' ]; then printf 'RETRY_%s' 'PRESERVED'; fi", 'RETRY_PRESERVED')
  console.log('installer: actual VM reboot starting')
  const reboot = await ssh('sudo -n systemctl reboot')
  expect([0, 255]).toContain(reboot.code)
  let newBoot = originalBoot
  await expect.poll(async () => {
    const result = await ssh('cat /proc/sys/kernel/random/boot_id')
    if (result.code !== 0) return false
    newBoot = result.stdout.trim()
    return newBoot !== originalBoot
  }, { timeout: 600_000, interval: 1000 }).toBe(true)
  await expect.poll(async () => { try { return (await fetch(`${origin}/login`)).status } catch { return 0 } }, { timeout: 90_000 }).toBe(200)
  expect(await successful('sudo -n sha256sum /etc/dsh-phalanx/environment')).toBe(originalConfig)
  // A fresh browser proves persisted server state independently of stale native terminal tabs.
  await memberContext.close()
  memberContext = await newValidationContext(browser); member = await memberContext.newPage()
  await enter()
  await runCommunityTerminal(member, "if [ \"$(cat installer-notes.txt)\" = 'INSTALLER_USER_FILE' ]; then printf 'BOOT_%s' 'PRESERVED'; fi", 'BOOT_PRESERVED')
  await stream()
  const service = await successful("sudo -n -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user is-enabled dsh-phalanx.service; sudo -n -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user is-active dsh-phalanx.service")
  expect(service.trim().split('\n')).toEqual(['enabled', 'active'])
  const namespaceRestriction = (await successful('cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns')).trim()
  expect(namespaceRestriction).toBe('1')
  await mkdir(evidence, { recursive: true, mode: 0o700 })
  await writeFile(join(evidence, 'installer-result.json'), JSON.stringify({ status: 'passed', installed, repeated,
    installerSha256: createHash('sha256').update(installerSource).digest('hex'),
    corruptCandidateExit: rejected.code, originalConfigSha256: originalConfig.trim().split(' ')[0], originalBoot, newBoot,
    rebooted: true, service: ['enabled', 'active'], apparmorUserNamespaceRestriction: 1,
    initialModelSupply: withoutInitialModel ? 'empty' : 'configured', defaultModel: 'real DSH native streaming via controlled upstream', nativeIdentity: 'non-root, provider secret absent', userFile: 'preserved across repeat/failure/reboot' }, null, 2)+'\n', { mode: 0o600 })
  console.log('installer: native model, retry, persistence and reboot passed')
}, 1_800_000)
