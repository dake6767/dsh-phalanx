// Validation: T4 owned formal baseline; real credentials: SSH access only. Never run on a live deployment.
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { installedReleaseFixture } from './support/installed-release-fixture.js'
import { installedRemoteReleaseFixture } from './support/installed-remote-release-fixture.js'

it('refuses the formal legacy deployment through its unchanged updater and the current CLI', async () => {
  const origin = process.env.DSH_PHALANX_OS_ORIGIN
  const address = process.env.DSH_PHALANX_OS_FIXTURE_ADDRESS
  const ssh = JSON.parse(process.env.DSH_PHALANX_OS_SSH_ARGS ?? 'null') as string[] | null
  const bundle = process.env.DSH_PHALANX_OS_BUNDLE,
    installer = process.env.DSH_PHALANX_OS_INSTALLER
  const releaseBundle = process.env.DSH_PHALANX_OS_RELEASE_BUNDLE
  const fixtureSource = process.env.DSH_PHALANX_OS_FIXTURE_SOURCE,
    fixtureNode = process.env.DSH_PHALANX_OS_FIXTURE_NODE
  const candidate = process.env.DSH_PHALANX_CANDIDATE_SHA,
    tag = process.env.DSH_PHALANX_CANDIDATE_TAG
  const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  if (
    !origin ||
    !address ||
    !ssh?.length ||
    !bundle ||
    !installer ||
    !(releaseBundle || (fixtureSource && fixtureNode)) ||
    Boolean(fixtureSource) !== Boolean(fixtureNode) ||
    (releaseBundle && fixtureSource) ||
    !candidate ||
    !tag ||
    !evidence ||
    ![bundle, installer].every(path => /^\/[a-zA-Z0-9/_.-]+$/u.test(path))
  )
    throw Error('Requires an owned formal baseline, exact bundle and protected SSH/evidence configuration')
  const remote = (command: string) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('ssh', [...ssh, command], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })
      let stdout = '',
        stderr = ''
      child.stdout.on('data', data => {
        stdout += String(data)
      })
      child.stderr.on('data', data => {
        stderr += String(data)
      })
      child.once('error', reject)
      child.once('close', code => resolve({ code, stdout, stderr }))
    })
  const checked = async (command: string) => {
    const result = await remote(command)
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }
  const baseline = JSON.parse(await readFile('releases/acceptance/0.1.24.json', 'utf8')) as { commit: string; platformSha256: string; imageDigest: string }
  const installed = JSON.parse(await checked('sudo cat /etc/dsh-phalanx/install-state.json')) as Record<string, unknown>
  expect(installed).toMatchObject({ version: 'v0.1.24', commit: baseline.commit, platformSha256: baseline.platformSha256, imageDigest: baseline.imageDigest })
  const link = (
    await checked(
      'sudo -u dsh-phalanx /opt/dsh-phalanx/current/start bootstrap-link --data-root /var/lib/dsh-phalanx/data --origin http://127.0.0.1:18080 --renew',
    )
  ).trim()
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const releaseNotes =
    'This version requires a fresh installation. 此版本需要全新安装。\nhttps://github.com/dake6767/dsh-phalanx/blob/main/docs/install.md#recoverable-system-updates'
  const port = Number(process.env.DSH_PHALANX_OS_FIXTURE_PORT ?? 0)
  const release =
    fixtureSource && fixtureNode
      ? await installedRemoteReleaseFixture({ ssh, source: fixtureSource, node: fixtureNode, directory: bundle, candidate, tag, port, releaseNotes })
      : await installedReleaseFixture(releaseBundle!, candidate, tag, port, releaseNotes)
  let accepted: object | undefined
  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ locale: 'en' }),
      page = await context.newPage()
    page.setDefaultTimeout(30_000)
    await page.goto(origin + new URL(link).pathname + new URL(link).hash)
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator', exact: true }).click()
    await page.waitForURL(origin + '/admin')
    const post = (path: string, data: object) => context.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
    const sources = (await (await context.request.get(origin + '/admin/api/download-sources')).json()) as { preset: string; overrides: Record<string, string> }
    const prefix = `http://${address}:${release.port}/`
    expect(
      (await post('download-sources', { preset: sources.preset, overrides: { ...sources.overrides, githubAssets: prefix, githubApi: prefix } })).status(),
    ).toBe(200)
    expect((await post('accounts', { username: 'member', password: 'password', email: '' })).status()).toBe(201)
    await checked("sudo -u dsh-phalanx sh -c 'printf LEGACY_MEMBER_DATA > /mnt/data/dsh-phalanx-users/upgrade-refusal-owned.txt'")
    const snapshot = async () =>
      JSON.parse(
        await checked(`sudo python3 - <<'PY'
import pathlib,json,hashlib,subprocess,re
root=pathlib.Path('/');sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
files=['/etc/dsh-phalanx/install-state.json','/etc/dsh-phalanx/installed-manifest.json','/etc/dsh-phalanx/environment','/mnt/data/dsh-phalanx-users/upgrade-refusal-owned.txt']
updater=pathlib.Path('/opt/dsh-phalanx/updater')
assert updater.is_symlink() and updater.resolve().parent==pathlib.Path('/opt/dsh-phalanx/updaters')
files.extend(str(p) for p in updater.rglob('*') if p.is_file())
manifest=json.loads((updater/'manifest.json').read_text())
assert manifest['schema']==1 and manifest['sourceCommit']=='${baseline.commit}'
assert set(manifest['files'])==set(json.loads((updater/'executor-files.json').read_text()))|{'updater.service.in','executor-files.json'}
for name,digest in manifest['files'].items():
 assert re.fullmatch(r'[a-zA-Z0-9_.-]+',name) and sha(updater/name)==digest
updater_pid=subprocess.check_output(['systemctl','show','dsh-phalanx-updater.service','-p','MainPID','--value'],text=True).strip()
assert int(updater_pid)>0
assert pathlib.Path('/proc/'+updater_pid+'/cwd').resolve()==updater.resolve()
current=pathlib.Path('/opt/dsh-phalanx/current')
assert json.loads((current/'build-info.json').read_text())['commit']=='${baseline.commit}'
assert (current/'.artifact-sha256').read_text()=='${baseline.platformSha256}'
configuration=pathlib.Path('/etc/dsh-phalanx/environment').read_text()
assert 'DSH_PHALANX_USER_DATA_ROOT="/mnt/data/dsh-phalanx-users"' in configuration

uid=subprocess.check_output(['id','-u','dsh-phalanx'],text=True).strip()
pid=subprocess.check_output(['runuser','-u','dsh-phalanx','--','env','XDG_RUNTIME_DIR=/run/user/'+uid,'systemctl','--user','show','dsh-phalanx.service','-p','MainPID','--value'],text=True).strip()
assert int(pid)>0 and not pathlib.Path('/etc/dsh-phalanx/maintenance').exists()
print(json.dumps({'files':{p:sha(p) for p in files},'current':str(pathlib.Path('/opt/dsh-phalanx/current').resolve()),'pid':pid,'executor':str(updater.resolve()),'updaterPid':updater_pid}))
PY`),
      ) as unknown
    const before = await snapshot(),
      accounts = (await (await context.request.get(origin + '/admin/api/accounts')).json()) as unknown
    const response = await post('system-update', { action: 'check' })
    expect(response.status()).toBe(200)
    const result = (await response.json()) as { check: { status: string; reason: string; releaseNotes: string } }
    expect(result.check.status).toBe('incompatible')
    expect(result.check.releaseNotes).toContain('requires a fresh installation')
    expect(result.check.releaseNotes).toContain('https://github.com/dake6767/dsh-phalanx/blob/main/docs/install.md')
    await page.getByRole('link', { name: 'System settings', exact: true }).click()
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
    await page.getByText('Release notes', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Download update', exact: true }).count()).toBe(0)
    expect(await page.locator('.update-notes').textContent()).toContain('requires a fresh installation')
    const refusal = await remote(`sudo bash ${installer} --version ${tag} --bundle-dir ${bundle} --upgrade prepare --output json`)
    expect(refusal.code).not.toBe(0)
    expect(refusal.stdout + refusal.stderr).toContain('requires a fresh installation')
    expect(refusal.stdout + refusal.stderr).not.toContain('Platform database status is unavailable')
    expect(await snapshot()).toEqual(before)
    expect(await (await context.request.get(origin + '/admin/api/accounts')).json()).toEqual(accounts)
    expect(
      (await context.request.post(origin + '/login', { headers: { origin }, form: { username: 'member', password: 'password' }, maxRedirects: 0 })).status(),
    ).toBe(303)
    accepted = {
      status: 'passed',
      baseline,
      candidate,
      tag,
      oldUpdater: result.check,
      cliRefused: true,
      deploymentUnchanged: true,
      accountLoginAfterRefusal: true,
      before,
      ...('identity' in release ? { remoteFixture: release.identity } : {}),
    }
  } finally {
    try {
      await browser?.close()
    } finally {
      await release.close()
    }
  }
  if (!accepted) throw Error('Legacy refusal did not complete')
  await writeFile(join(evidence, 'upgrade-refusal.json'), JSON.stringify(accepted, null, 2) + '\n')
}, 300_000)
