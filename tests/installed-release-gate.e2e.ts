// Validation: T4 isolated host; real credentials: SSH access to the owned validation VM; no provider key. Never run on a live deployment.
import { verifyInstalledFreshGate } from './support/installed-fresh-release.js'
import { installedUserDataRoot, installedShellArgument } from './support/installed-storage-layout.js'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { execFileText } from '../src/adapters/runtime-command.js'
import { formalUpgradeScope } from '../scripts/validation/formal-baseline.mjs'
import { downloadSourcePresets } from '../src/domain/download-source.js'
import { signInCommunity } from './fixtures/community-native-browser.js'

const service = 'sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx)'

/** Final pre-release gate follows the declared fresh-install boundary or the normal online upgrade path.
 * Both paths bind exact Candidate bytes and actual member entry; normal functional coverage also lives in T2. */
it('verifies the declared candidate installation path and lets a member enter DSH', async () => {
  const origin = process.env.DSH_PHALANX_OS_ORIGIN,
    installer = process.env.DSH_PHALANX_OS_INSTALLER
  const ssh = JSON.parse(process.env.DSH_PHALANX_OS_SSH_ARGS ?? 'null') as string[] | null
  const candidate = process.env.DSH_PHALANX_CANDIDATE_SHA,
    tag = process.env.DSH_PHALANX_CANDIDATE_TAG
  if (
    !origin ||
    !ssh?.length ||
    !candidate ||
    !/^[a-f0-9]{40}$/u.test(candidate) ||
    !tag ||
    !/^run-[1-9]\d*$/u.test(tag) ||
    !installer ||
    !/^\/[a-zA-Z0-9/_.-]+$/u.test(installer)
  )
    throw Error('Requires an isolated formal baseline VM, the exact candidate identity and protected SSH configuration')
  const remote = (command: string, timeout = 120000) => execFileText('ssh', [...ssh, `cd / && ${command}`], { timeout, maxBuffer: 4 * 1024 * 1024 })
  const target = (JSON.parse(await readFile('package.json', 'utf8')) as { version: string }).version
  const source = (
    JSON.parse(await readFile('release-policy.json', 'utf8')) as {
      compatibility: { source: { min: string; maxExclusive: string }; freshInstallThrough?: string }
    }
  ).compatibility
  const scope = formalUpgradeScope(await readdir('releases/acceptance'), target, source.source, source.freshInstallThrough)
  if (scope.freshInstall) return verifyInstalledFreshGate({ remote, origin, candidate, tag, target })
  if (!scope.upgrade || scope.previous === undefined) throw Error(`Version ${target} has no formal previous release to upgrade from`)
  const baseline = JSON.parse(await readFile(`releases/acceptance/${scope.previous}.json`, 'utf8')) as {
    commit: string
    platformSha256: string
    imageDigest: string
  }
  const started = Date.now(),
    steps: Record<string, number> = {}
  const step = async <T>(name: string, action: () => Promise<T>) => {
    const at = Date.now()
    const value = await action()
    steps[name] = Date.now() - at
    return value
  }
  const browser = await chromium.launch({ headless: true }),
    admin = await browser.newPage({ locale: 'en' }),
    member = await browser.newPage({ locale: 'en' })
  let passed = false,
    operation: unknown
  try {
    await step('baseline', async () => {
      expect(JSON.parse(await remote('sudo cat /etc/dsh-phalanx/install-state.json'))).toMatchObject({
        version: 'v' + scope.previous,
        commit: baseline.commit,
        platformSha256: baseline.platformSha256,
        imageDigest: baseline.imageDigest,
      })
      const credential = (await remote('sudo cat /var/lib/dsh-phalanx/data/bootstrap-credential')).trim().split(/\s/u)[0]!
      expect(
        (
          await admin.request.post(origin + '/bootstrap', {
            headers: { origin },
            form: { credential, username: 'admin', password: 'password' },
            maxRedirects: 0,
          })
        ).status(),
      ).toBe(303)
      expect(
        (
          await admin.request.post(origin + '/admin/api/accounts', { headers: { origin }, data: { username: 'member', password: 'password', email: '' } })
        ).status(),
      ).toBe(201)
      // The first entry creates the member home on the previous release.
      await signInCommunity(member, origin, 'member', 'password')
      await remote(
        `${service} sh -c ` +
          installedShellArgument(
            'printf GATE_DATA_PRESERVED > ' + installedShellArgument((await installedUserDataRoot(remote)) + '/member/home/gate-owned.txt'),
          ),
      )
    })
    operation = await step('upgrade', async () => {
      // The shipped mainland preset and GitHub prefix fetch the published candidate; nothing is preloaded.
      const prefix = downloadSourcePresets.mainland.githubAssets
      const result = JSON.parse(
        await remote(
          `sudo bash ${installer} --version ${tag} --dev-release-base-url https://github.com/dake6767/dsh-phalanx-candidates/releases --download-source-preset mainland --github-proxy-prefix ${prefix} --yes --output json`,
          3600000,
        ),
      )
      expect(result).toMatchObject({
        status: 'upgrade',
        operation: { phase: 'succeeded', sourceVersion: scope.previous, targetVersion: target, targetCommit: candidate, cleanup: { status: 'succeeded' } },
      })
      return result.operation
    })
    await step('enter', async () => {
      expect(JSON.parse(await remote('sudo cat /opt/dsh-phalanx/current/build-info.json')).commit).toBe(candidate)
      await expect
        .poll(
          async () => {
            try {
              return (await fetch(origin + '/login')).status
            } catch {
              return 0
            }
          },
          { timeout: 300000 },
        )
        .toBe(200)
      expect(
        (await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status(),
      ).toBe(303)
      expect((await admin.request.get(origin + '/admin/api/accounts')).status()).toBe(200)
      await member.context().clearCookies()
      // The first entry after an upgrade cold-starts the instance under the product's own 300 s deadline,
      // then loads DSH; in an emulated VM both together exceed the shared fixture's 300 s wait.
      await member.goto(origin + '/login')
      await member.getByLabel('Username', { exact: true }).fill('member')
      await member.getByLabel('Password', { exact: true }).fill('password')
      const submitted = member.waitForResponse(response => new URL(response.url()).pathname === '/login' && response.request().method() === 'POST', {
        timeout: 300000,
      })
      await member.getByRole('button', { name: 'Sign in', exact: true }).click({ noWaitAfter: true })
      expect((await submitted).status()).toBe(303)
      await member.waitForURL(url => url.origin === origin && /^\/app\/[^/]+\/$/u.test(url.pathname), { timeout: 300000 })
      await member.locator('#root').waitFor({ state: 'attached', timeout: 600000 })
      expect(await remote('sudo cat ' + installedShellArgument((await installedUserDataRoot(remote)) + '/member/home/gate-owned.txt'))).toBe(
        'GATE_DATA_PRESERVED',
      )
    })
    passed = true
  } finally {
    await browser.close()
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR)
      await writeFile(
        join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'installed-release-gate-result.json'),
        JSON.stringify({
          passed,
          tier: 'T4',
          gate: 'release',
          candidate,
          tag,
          baseline: baseline.commit,
          previous: scope.previous,
          target,
          transport: 'mainland-online',
          operation,
          steps,
          seconds: Math.round((Date.now() - started) / 1000),
        }) + '\n',
      )
  }
}, 5400000)
