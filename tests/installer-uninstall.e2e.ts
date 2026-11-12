// Validation: T4 isolated disposable Linux VM; real credentials: SSH access to the owned VM, no provider key.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { newValidationContext } from './fixtures/browser-evidence.js'
import { runCommunityTerminal, selectCommunityWorkspace, signInCommunity } from './fixtures/community-native-browser.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'
import { instanceWorkspacePath } from './support/real-dsh-runtime.js'

const exec = promisify(execFile)
const build = '/var/lib/dsh-phalanx-dev'
const home = '/var/lib/dsh-phalanx'
const mount = '/mnt/phalanx-uninstall-validation'
const externalRoot = mount + '/members'
const serviceUser = 'sudo -n runuser -u dsh-phalanx --'
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

it('reinstalls retained member spaces and removes only owned local data in an isolated VM', async () => {
  const config = process.env.DSH_PHALANX_UNINSTALL_SSH_CONFIG
  const target = process.env.DSH_PHALANX_UNINSTALL_SSH_TARGET
  const nonce = process.env.DSH_PHALANX_UNINSTALL_NONCE
  const commit = process.env.DSH_PHALANX_CANDIDATE_SHA
  const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  const origin = process.env.DSH_PHALANX_UNINSTALL_ORIGIN
  if (
    !evidence ||
    !config ||
    !target ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(target) ||
    !nonce ||
    !/^[a-f0-9-]{36}$/u.test(nonce) ||
    !commit ||
    !/^[a-f0-9]{40}$/u.test(commit) ||
    !origin ||
    !/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin)
  ) {
    throw Error('Requires a registered disposable uninstall validation VM')
  }
  const ssh = async (command: string, expectedFailure = false) => {
    try {
      const result = await exec('ssh', ['-F', config, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, 'cd / && ' + command], {
        timeout: 420_000,
        maxBuffer: 2 * 1024 * 1024,
      })
      if (expectedFailure) throw Error('Expected the command to reject a nested mount')
      return result.stdout.trim()
    } catch (error) {
      if (expectedFailure && typeof error === 'object' && error !== null && 'code' in error && error.code === 1 && 'stdout' in error)
        return String(error.stdout).trim()
      throw error
    }
  }
  const owner = JSON.parse(
    await ssh(
      `sudo -n test "$(sudo -n stat -c '%u:%a' ${build}/uninstall-validation-owner.json)" = 0:600 && sudo -n cat ${build}/uninstall-validation-owner.json`,
    ),
  )
  expect(owner).toEqual({ purpose: 'disposable-uninstall-validation', nonce, commit })
  const manifest = JSON.parse(await ssh(`cat ${build}/bundle/manifest.json`)) as { commit: string; tag: string; platform: string }
  expect(manifest.commit).toBe(commit)
  expect(manifest.tag).toMatch(/^v\d+\.\d+\.\d+-rc\.\d+$/u)
  expect(JSON.parse(await ssh('cat /opt/dsh-phalanx/current/build-info.json')).commit).toBe(commit)
  const rootlessPodman = `sudo -n runuser -u dsh-phalanx -- env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) podman`
  const dbImage = await ssh(`${rootlessPodman} inspect --format '{{.Image}}' dsh-phalanx-postgres`)
  expect(dbImage).toMatch(/^(?:sha256:)?[a-f0-9]{64}$/u)
  const install = (options = '') =>
    ssh(
      `sudo -n bash ${build}/source/install.sh ${manifest.platform === 'linux/arm64' ? '--dev-arm64' : ''} --bundle-dir ${build}/bundle --version ${quote(manifest.tag)} --non-interactive --output json ${options}`,
    )
  const pg = 'validation-external-' + randomUUID()
  const pgPassword = 'uninstall-fixture-password'
  const password = 'uninstall-member-password'
  const browser = await chromium.launch({ headless: true })
  let externalStarted = false
  let mounted = false
  let nested = false
  const nestedMount = externalRoot + '/validation-nested'
  const verified: string[] = []
  const errors: unknown[] = []
  try {
    for (const mode of ['builtin', 'external'] as const) {
      if (mode === 'external') {
        await ssh(`sudo -n mkdir -p ${mount} && sudo -n mount -t tmpfs -o size=256m tmpfs ${mount}`)
        mounted = true
        await ssh(`printf shared | sudo -n tee ${mount}/neighbor >/dev/null`)
        await ssh(
          `${rootlessPodman} run -d --name ${pg} --pull=never --network=pasta -p 127.0.0.1:25437:5432 -e POSTGRES_USER=validation -e POSTGRES_PASSWORD=${pgPassword} ${dbImage}`,
        )
        externalStarted = true
        await expect.poll(() => ssh(`${rootlessPodman} exec ${pg} pg_isready -U validation || true`), { timeout: 45_000 }).toContain('accepting connections')
        await install(
          `--port ${new URL(origin).port} --public-origin ${quote(origin)} --host-public-addresses '' --user-data-root ${externalRoot} --user-data-mount ${mount}`,
        )
      }
      const context = await newValidationContext(browser, { locale: 'en' })
      const admin = await context.newPage()
      const link = await ssh(`${serviceUser} /opt/dsh-phalanx/current/start bootstrap-link --data-root ${home}/data --origin ${quote(origin)}`)
      await admin.goto(link)
      if (mode === 'external') {
        await admin.getByLabel('Platform database', { exact: true }).selectOption('external')
        for (const [label, value] of [
          ['Database host', '127.0.0.1'],
          ['Database port', '25437'],
          ['Database name', 'validation'],
          ['Database username', 'validation'],
          ['Database password', pgPassword],
        ])
          await admin.getByLabel(label!, { exact: true }).fill(value!)
        await admin.getByLabel('TLS mode', { exact: true }).selectOption('disable')
        await admin.getByRole('button', { name: 'Test connection', exact: true }).click()
        await expect.poll(() => admin.getByRole('button', { name: 'Continue', exact: true }).isEnabled()).toBe(true)
        await admin.getByRole('button', { name: 'Continue', exact: true }).click()
      } else await selectBuiltinDatabase(admin)
      await admin.getByLabel('Username').fill('admin')
      await admin.getByLabel('Password', { exact: true }).fill(password)
      await admin.getByRole('button', { name: 'Create administrator', exact: true }).click()
      await admin.getByRole('button', { name: 'Skip for now and finish installation', exact: true }).click()
      await admin.waitForURL(origin + '/admin')
      const post = (path: string, data: object) => context.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
      const create = async (username: string) => expect((await post('accounts', { username, password, email: '' })).status()).toBe(201)
      const enter = async (username: string, value?: string) => {
        const member = await newValidationContext(browser, { locale: 'en' })
        const page = await member.newPage()
        try {
          await signInCommunity(page, origin, username, password)
          const workspace = instanceWorkspacePath('', true)
          await selectCommunityWorkspace(member, page, origin, workspace, true)
          const retained = workspace + '/uninstall-retention.txt'
          const marker = value ?? 'retained-after-reinstall-' + username
          const command = value === undefined ? `cat ${quote(retained)}` : `printf %s ${quote(value)} > ${quote(retained)} && cat ${quote(retained)}`
          await runCommunityTerminal(page, command, marker)
        } finally {
          await member.close()
        }
      }
      await create('legacy')
      await create('renewed')
      // Represent a persisted pre-upgrade account before its first instance starts.
      // No existing files are moved; the installed reader must honor the old mapping.
      const legacyMapping = `import { FilePlatformDatabaseConfig } from '/opt/dsh-phalanx/current/dist/adapters/platform-database-config.js';
        import { PlatformDatabase } from '/opt/dsh-phalanx/current/dist/adapters/platform-database.js';
        const config=FilePlatformDatabaseConfig.open('${home}/keys/database.json','${home}/data');
        const db=new PlatformDatabase(config.connection,config.security);
        try { await db.initialize(); await db.query("UPDATE dsh_phalanx.accounts SET storage_key=username WHERE username IN ('legacy','renewed')"); } finally { await db.close(); }`
      await ssh(`${serviceUser} /opt/dsh-phalanx/current/node/bin/node --input-type=module -e ${quote(legacyMapping)}`)
      await admin.reload()
      await admin.getByRole('button', { name: 'Edit legacy', exact: true }).click()
      const drawer = admin.getByRole('dialog', { name: 'Edit account: legacy', exact: true })
      await drawer.getByText('Resident instance', { exact: true }).click()
      await drawer.getByRole('button', { name: 'Save changes', exact: true }).click()
      await drawer.waitFor({ state: 'detached' })
      await enter('legacy', 'retained-after-reinstall-legacy')
      await enter('renewed', 'retired-space-content')
      expect((await post('accounts/renewed/actions', { action: 'delete' })).status()).toBe(200)
      await create('renewed')
      await enter('renewed', 'retained-after-reinstall-renewed')
      const users = mode === 'builtin' ? home + '/data.durable/users' : externalRoot
      const names = await ssh(`sudo -n find ${users} -name uninstall-retention.txt -printf '%P\\n' | sort`)
      expect(names.split('\n')).toHaveLength(3)
      expect(names).toMatch(/^_spaces\/[a-f0-9]{32}\/home\//mu)
      expect(names).toMatch(/^legacy\/home\//mu)
      expect(names).toMatch(/^renewed\/home\//mu)
      const fingerprint = () => ssh(`sudo -n sha256sum ${home}/keys/master.key ${home}/keys/database.json`)
      const original = await fingerprint()
      const saved = JSON.parse(await ssh('sudo -n dsh-phalanx uninstall --yes --language en --output json'))
      expect(saved).toMatchObject({ state: 'uninstalled', status: 'succeeded', changed: true })
      expect(await fingerprint()).toBe(original)
      await ssh('test ! -e /usr/local/bin/dsh-phalanx && test ! -e /opt/dsh-phalanx/current')
      const enabled = await ssh('systemctl list-unit-files --state=enabled --no-legend')
      expect(enabled).not.toContain('dsh-phalanx-updater.service')
      const userEnabled = await ssh(
        `${serviceUser} env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user list-unit-files --state=enabled --no-legend`,
      )
      expect(userEnabled).not.toContain('dsh-phalanx.service')
      expect(await ssh(`${rootlessPodman} ps --filter label=dsh-phalanx.community=1 --format '{{.ID}}'`)).toBe('')
      await install()
      expect(await fingerprint()).toBe(original)
      await expect
        .poll(() => ssh(`${rootlessPodman} ps --filter label=dsh-phalanx.user=legacy --format '{{.ID}}'`), { timeout: 120_000 })
        .toMatch(/^[a-f0-9]{12,64}$/u)
      await enter('legacy')
      await enter('renewed')
      await ssh(`sudo -n grep -Rlx 'retired-space-content' ${users}/renewed/home/Documents/deepseek-harness/default-workspace/uninstall-retention.txt`)
      const standalonePurge = `sudo -n bash ${build}/source/install.sh ${manifest.platform === 'linux/arm64' ? '--dev-arm64' : ''} --uninstall --purge --yes --output json`
      const command = mode === 'external' ? standalonePurge : 'sudo -n dsh-phalanx uninstall --purge --yes --output json'
      if (mode === 'external') {
        await ssh('sudo -n dsh-phalanx uninstall --yes --output json')
        await ssh(`sudo -n mkdir ${nestedMount} && sudo -n mount -t tmpfs -o size=8m tmpfs ${nestedMount}`)
        nested = true
        const blocked = JSON.parse(await ssh(command, true))
        expect(blocked).toMatchObject({ state: 'partial', status: 'failed', pending: expect.arrayContaining([externalRoot]) })
        await ssh(`sudo -n test -f ${home}/keys/master.key && sudo -n test -f ${users}/.dsh-phalanx-storage.json`)
        await ssh(`sudo -n umount ${nestedMount}`)
        nested = false
      }
      const purged = JSON.parse(await ssh(command))
      expect(purged).toMatchObject({ state: 'purged', status: 'succeeded' })
      expect(JSON.parse(await ssh(standalonePurge))).toMatchObject({ state: 'purged', status: 'succeeded', changed: false })
      await ssh(`sudo -n test ! -e ${users} && sudo -n test ! -e ${home}/keys && getent passwd dsh-phalanx >/dev/null`)
      if (mode === 'external') {
        expect(await ssh(`cat ${mount}/neighbor`)).toBe('shared')
        expect(await ssh(`${rootlessPodman} exec ${pg} psql -U validation -d validation -Atc 'SELECT count(*) FROM dsh_phalanx.accounts'`)).toBe('3')
      }
      verified.push(mode)
      await context.close()
    }
  } catch (error) {
    errors.push(error)
  } finally {
    const cleanup = [() => browser.close()]
    if (externalStarted)
      cleanup.push(async () => {
        await ssh(`${rootlessPodman} rm --force ${pg}`)
      })
    if (nested) {
      try {
        await ssh(`sudo -n umount ${nestedMount}`)
      } catch (error) {
        errors.push(error)
      }
    }
    if (mounted)
      cleanup.push(async () => {
        await ssh(`sudo -n umount ${mount}`)
      })
    const outcomes = await Promise.allSettled(cleanup.map(action => action()))
    for (const outcome of outcomes) if (outcome.status === 'rejected') errors.push(outcome.reason)
  }
  await mkdir(evidence, { recursive: true, mode: 0o700 })
  await writeFile(join(evidence, 'uninstall.json'), JSON.stringify({ source: commit, verified, passed: errors.length === 0 }) + '\n', { mode: 0o600 })
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Uninstall validation and cleanup failed')
}, 1_800_000)
