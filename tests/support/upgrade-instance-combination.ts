import { installedUserDataRoot } from './installed-storage-layout.js'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { dshWebProfilePath, DSH_PATCH_CONFIG } from '../../src/dsh/profile-layout.js'
import { expect } from 'vitest'
import { instanceWorkspacePath } from './real-dsh-runtime.js'
import type { Page } from 'playwright'
import type { CommunityInstanceResourceMember, CommunityInstanceResourceSettings } from '../../src/domain/admin-contract.js'
import { openCommunityAccountMenu, selectCommunityWorkspace, openCommunitySession, runCommunityTerminal } from '../fixtures/community-native-browser.js'

interface Host {
  origin: string
  admin: Page
  member: Page
  remote(command: string, timeout?: number): Promise<string>
}
interface Deployment {
  defaults: { cpus: number | null; memoryMiB: number | null; pids: number | null }
  idleSeconds: number
  finite: boolean
  persisted: boolean
}
const unlimited = { cpus: null, memoryMiB: null, pids: null }
const dataRoot = '/var/lib/dsh-phalanx/data'
const workspace = instanceWorkspacePath('', true)
const relativePatch = relative('/member-home', join(dshWebProfilePath('/member-home'), DSH_PATCH_CONFIG))
const rootHash = createHash('sha256').update(dataRoot).digest('hex')
const shell = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const service = 'sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx)'

/** Real installed-host checks shared by formal T2 and both T4 upgrade transports. */
export function installedInstanceAcceptance({ origin, admin, member, remote }: Host) {
  const endpoint = origin + '/admin/api/instance-resources'
  const get = async <T>(suffix = ''): Promise<T> => {
    const response = await admin.request.get(endpoint + suffix)
    expect(response.status()).toBe(200)
    return response.json()
  }
  const settings = () => get<CommunityInstanceResourceSettings>()
  const state = () => get<CommunityInstanceResourceMember>('?username=member')
  const post = async (body: object) => {
    const response = await admin.request.post(endpoint, { headers: { origin }, data: body })
    expect(response.status(), await response.text()).toBe(200)
    return response.json()
  }
  const carriers = async () =>
    (
      await remote(
        `${service} podman ps --filter label=dsh-phalanx.community=1 --filter label=dsh-phalanx.community-root=${rootHash} --filter label=dsh-phalanx.user=member --format '{{.ID}}'`,
      )
    )
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
  const carrier = async () => {
    const rows = await carriers()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatch(/^[a-f0-9]{12,64}$/u)
    return rows[0]!
  }
  const python = (code: string) => remote('sudo python3 -c ' + shell(code))
  const kernel = async () =>
    JSON.parse(
      await remote(
        `${service} podman exec ${await carrier()} node -e ${shell("const fs=require('fs');console.log(JSON.stringify(Object.fromEntries(['cpu.max','memory.max','memory.swap.max','pids.max'].map(n=>[n,fs.readFileSync('/sys/fs/cgroup/'+n,'utf8').trim()]))))")}`,
      ),
    ) as Record<string, string>
  const limits = (values: Record<string, string>, expected: Deployment['defaults'], swap = true, comparePids = true) => {
    const [quota, period] = values['cpu.max']!.split(' ')
    if (expected.cpus === null) expect(quota).toBe('max')
    else expect(Number(quota) / Number(period)).toBe(expected.cpus)
    expect(values['memory.max']).toBe(expected.memoryMiB === null ? 'max' : String(expected.memoryMiB * 1024 ** 2))
    if (comparePids) expect(values['pids.max']).toBe(expected.pids === null ? 'max' : String(expected.pids))
    if (swap) expect(values['memory.swap.max']).toBe(expected.memoryMiB === null ? 'max' : '0')
  }
  const environment = async (overrides: Record<string, string | null>) => {
    const encoded = Buffer.from(JSON.stringify(overrides)).toString('base64')
    // Preserve every other protected value without bringing it into this process or its evidence.
    await python(`from pathlib import Path
import shlex,json,base64,os,uuid,pwd,stat
p=Path('/etc/dsh-phalanx/environment')
metadata=p.lstat()
assert stat.S_ISREG(metadata.st_mode) and metadata.st_uid==0 and metadata.st_gid==pwd.getpwnam('dsh-phalanx').pw_gid and stat.S_IMODE(metadata.st_mode)==0o640
values={}
for line in p.read_text().splitlines():
 k,v=line.split('=',1); parts=shlex.split(v); assert len(parts)==1; values[k]=parts[0]
for k,v in json.loads(base64.b64decode('${encoded}')).items():
 if v is None: values.pop(k,None)
 else: values[k]=v
text=''.join(k+'="'+v.replace('\\\\','\\\\\\\\').replace('"','\\\\"')+'"\\n' for k,v in sorted(values.items()))
temporary=p.with_name('environment.acceptance-'+uuid.uuid4().hex)
fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
os.fchown(fd,metadata.st_uid,metadata.st_gid); os.fchmod(fd,stat.S_IMODE(metadata.st_mode))
with os.fdopen(fd,'w') as stream: stream.write(text); stream.flush(); os.fsync(stream.fileno())
os.replace(temporary,p)`)
  }
  const restart = async () => {
    await remote(`${service} systemctl --user restart dsh-phalanx.service`, 300000)
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
  }
  const adminLogin = async () => {
    await admin.context().clearCookies()
    expect(
      (await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status(),
    ).toBe(303)
  }
  return {
    kernel,
    assertBaselineLimits(values: Record<string, string>, expected: Deployment) {
      // The old release inherits the engine's PID default when no flag was supplied.
      // The upgraded platform is still checked strictly for explicit unlimited values.
      if (!expected.persisted && !expected.finite) expect(values['pids.max']).toMatch(/^(?:max|[1-9]\d*)$/u)
      limits(values, expected.defaults, expected.persisted || !expected.finite, expected.persisted || expected.finite)
    },
    async configureCatalog(address: string) {
      await environment({ DSH_PHALANX_SUITE_CATALOG_ADDRESS: address })
      await restart()
      await adminLogin()
    },
    async prepareBaseline(finite: boolean): Promise<Deployment> {
      // Releases with saved instance settings must be configured through their API;
      // legacy releases import the deployment environment only during the upgrade.
      const response = await admin.request.get(endpoint)
      expect([200, 404]).toContain(response.status())
      const persisted = response.status() === 200
      const expected = {
        defaults: finite ? { cpus: persisted ? 2 : 0.75, memoryMiB: 2048, pids: 512 } : unlimited,
        idleSeconds: finite ? 97 : 1800,
        finite,
        persisted,
      }
      if (persisted) {
        const current = await response.json()
        await post({ action: 'save-defaults', revision: current.revision, limits: expected.defaults, idleSeconds: expected.idleSeconds })
      } else await remote('sudo test ! -e /var/lib/dsh-phalanx/data/instance-resources.json')
      await environment({
        DSH_PHALANX_CONTAINER_ARGS_JSON: finite
          ? JSON.stringify(['--cpus', String(expected.defaults.cpus), '--memory', '2048m', '--pids-limit', String(expected.defaults.pids)])
          : null,
        DSH_PHALANX_IDLE_RECLAIM_SECONDS: finite ? '97' : null,
      })
      await restart()
      return expected
    },
    async assertImported(expected: Deployment) {
      expect(await settings()).toMatchObject({ defaults: expected.defaults, idleSeconds: expected.idleSeconds })
      expect(await state()).toMatchObject({ source: 'default', resident: false, target: expected.defaults, pending: false })
      const importedKernel = await kernel()
      limits(importedKernel, expected.defaults)
      return importedKernel
    },
    async verifyCombination(entry: string, sessionId: string) {
      const bookmark = origin + entry + '?view=workspace#saved'
      // Scope the two-second timer to reclamation so it does not reclaim the next cold entry.
      const reclaim = async () => {
        await post({ action: 'save-defaults', revision: (await settings()).revision, limits: (await settings()).defaults, idleSeconds: 2 })
        await member.goto(origin + '/recovery')
        await expect.poll(async () => (await state()).instanceKey, { timeout: 120000 }).toBeNull()
        expect(await carriers()).toHaveLength(0)
        await post({ action: 'save-defaults', revision: (await settings()).revision, limits: (await settings()).defaults, idleSeconds: 0 })
      }
      await reclaim()
      await member.context().clearCookies()
      await member.goto(origin + '/login')
      await member.getByLabel('Username', { exact: true }).fill('member')
      await member.getByLabel('Password', { exact: true }).fill('password')
      const loggedIn = member.waitForResponse(response => new URL(response.url()).pathname === '/login' && response.request().method() === 'POST')
      await member.getByRole('button', { name: 'Sign in', exact: true }).click({ noWaitAfter: true })
      expect((await loggedIn).status()).toBe(303)
      await member.locator('[data-platform-startup]').waitFor()
      expect(new URL(member.url()).pathname).toBe(entry)
      await member.locator('#root').waitFor({ state: 'attached', timeout: 300000 })
      await reclaim()
      await member.goto(bookmark, { waitUntil: 'domcontentloaded' })
      await member.locator('[data-platform-startup]').waitFor()
      expect(member.url()).toBe(bookmark)
      await member.locator('#root').waitFor({ state: 'attached', timeout: 300000 })
      expect(member.url()).toBe(bookmark)
      await admin.goto(origin + '/admin')
      await admin.getByRole('link', { name: 'System settings', exact: true }).click()
      const form = admin.getByRole('region', { name: 'Member instances', exact: true })
      // Ordinary deployment values; extreme limits belong to the cgroup T2 cases, not cold installed startup.
      await form.getByLabel('CPU (cores)', { exact: true }).fill('2')
      await form.getByLabel('Memory (MiB)', { exact: true }).fill('2048')
      await form.getByLabel('Processes', { exact: true }).fill('1024')
      await form.getByRole('button', { name: 'Save instance limits', exact: true }).click()
      await form.getByRole('status').filter({ hasText: 'Instance limits saved.' }).waitFor()
      const target = { cpus: 2, memoryMiB: 2048, pids: 1024 }
      expect((await state()).pending).toBe(true)
      await form.getByRole('button', { name: 'Apply to running instances (1)', exact: true }).click()
      const dialog = admin.getByRole('dialog', { name: 'Apply resource limits?', exact: true })
      const applying = admin.waitForResponse(
        response => response.url() === endpoint && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'apply',
      )
      await dialog.getByRole('button', { name: 'Apply now', exact: true }).click()
      const application = await (await applying).json()
      expect(application.results).toHaveLength(1)
      expect(application.results[0]).toMatchObject({ username: 'member', status: 'applied' })
      limits(await kernel(), target)
      expect((await state()).pending).toBe(false)
      const current = await state()
      expect(current.spaceId).toMatch(/^[a-f0-9]{32}$/u)
      await post({ action: 'save-member', revision: current.revision, username: 'member', spaceId: current.spaceId, override: null, resident: true })
      const oldCarrier = await carrier()
      await member.goto(origin + '/recovery')
      await environment({
        DSH_PHALANX_CONTAINER_ARGS_JSON: null,
        DSH_PHALANX_IDLE_RECLAIM_SECONDS: '9',
      })
      await restart()
      await adminLogin()
      expect(await settings()).toMatchObject({ defaults: target, idleSeconds: 0 })
      // Keep readiness observation from competing with the member's startup work.
      await expect.poll(async () => (await state()).instanceKey, { timeout: 300000, interval: 1000 }).not.toBeNull()
      const residentCarrier = await carrier()
      expect(residentCarrier).not.toBe(oldCarrier)
      expect(await state()).toMatchObject({ resident: true, pending: false })
      limits(await kernel(), target)
      await member.goto(origin + entry)
      await member.locator('#root').waitFor({ state: 'attached', timeout: 300000 })
      expect(await carrier()).toBe(residentCarrier)
      await selectCommunityWorkspace(member.context(), member, origin, workspace, true)
      await runCommunityTerminal(
        member,
        'printf COMBINATION_PROJECT > combination-project.txt; printf COMBINATION_HOME > "$HOME/combination-home.txt"; printf COMBINATION_SAVED',
        'COMBINATION_SAVED',
      )
      await openCommunitySession(member, sessionId)
      await member
        .locator(`[data-conversation-content][data-conversation-session=${JSON.stringify(sessionId)}]:visible`)
        .getByText('AFTER_RECORDS_RESTART', { exact: true })
        .waitFor()
      await openCommunityAccountMenu(member)
      await member.getByRole('menuitem', { name: 'More recovery options', exact: true }).click()
      await member.waitForURL(origin + '/recovery')
      await python(
        `from pathlib import Path\np=Path(${JSON.stringify(join(dshWebProfilePath((await installedUserDataRoot(remote)) + '/member/home'), DSH_PATCH_CONFIG))})\nassert p.is_file() and not p.is_symlink()\np.write_text('broken-combination-profile: true\\n')`,
      )
      const reset = member.locator('#reset-environment')
      await reset.getByRole('checkbox').check()
      // Reset also stops the old carrier and backs up its environment before the new startup.
      const resetting = member.waitForResponse(response => new URL(response.url()).pathname === '/recovery/reset', { timeout: 600000 })
      await reset.getByRole('button', { name: 'Reset environment', exact: true }).click()
      const response = await resetting
      expect(response.status()).toBe(200)
      expect(await response.json()).toEqual({ entry })
      await member.locator('#reset-status').filter({ hasText: 'DSH environment reset.' }).waitFor()
      const backupCount = Number(
        await python(
          `from pathlib import Path\nimport json,shlex\nvalues={}\nfor line in Path('/etc/dsh-phalanx/environment').read_text().splitlines():\n if line.startswith('DSH_PHALANX_USER_DATA_ROOT='): values['root']=shlex.split(line.split('=',1)[1])[0]\np=Path(values.get('root',${JSON.stringify(await installedUserDataRoot(remote))}))/'_environment-backups'/'${current.spaceId}'\nrows=[d for d in p.iterdir() if d.is_dir()]\nassert all((d/'manifest.json').is_file() and (d/'README.txt').is_file() for d in rows)\nassert any((d/'files/${relativePatch}').read_text()=='broken-combination-profile: true\\n' for d in rows)\nprint(len(rows))`,
        ),
      )
      expect(backupCount).toBeGreaterThan(0)
      expect(backupCount).toBeLessThanOrEqual(3)
      const limited = await member.request.post(origin + '/recovery/reset', { headers: { origin }, data: { confirmed: true } })
      expect(limited.status()).toBe(409)
      expect(await limited.json()).toMatchObject({ code: 'environment-reset-rate-limited' })
      await member.getByRole('link', { name: 'Return to DSH', exact: true }).click()
      await member.locator('#root').waitFor({ state: 'attached', timeout: 300000 })
      await selectCommunityWorkspace(member.context(), member, origin, workspace, true)
      await openCommunitySession(member, sessionId)
      await member
        .locator(`[data-conversation-content][data-conversation-session=${JSON.stringify(sessionId)}]:visible`)
        .getByText('AFTER_RECORDS_RESTART', { exact: true })
        .waitFor()
      await runCommunityTerminal(member, 'cat combination-project.txt "$HOME/combination-home.txt"', 'COMBINATION_PROJECTCOMBINATION_HOME')
      const resetCarrier = await carrier()
      expect(resetCarrier).not.toBe(residentCarrier)
      expect((await state()).resident).toBe(true)
      limits(await kernel(), target)
      const accounts = await (await admin.request.get(origin + '/admin/api/accounts')).json()
      expect(accounts.items.find((row: { username: string }) => row.username === 'member').lastEnvironmentReset).toMatchObject({
        username: 'member',
        role: 'member',
        at: expect.any(Number),
      })
      return {
        loginOverlay: true,
        reclaimedBookmarkOverlay: true,
        bookmarkPreserved: true,
        appliedKernel: await kernel(),
        application: application.results[0],
        settingsOverrideChangedLegacyEnvironment: true,
        residentRestartBeforeNavigation: true,
        resetResidentFlagPreserved: true,
        memberResetEntryOnly: true,
        backupCount,
        projectsHomeAndChatPreserved: true,
        memberCooldownEnforced: true,
      }
    },
  }
}
