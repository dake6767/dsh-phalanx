// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { openCommunityHttpEntry } from './support/community-http-entry.js'
import { chromium, type Browser } from 'playwright'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, CONTAINER_HOME, runtimeSection } from './support/real-dsh-runtime.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { communityEntryUrl } from './support/community-space.js'
import { skillZip } from './fixtures/skills/archive.js'

it.skipIf(!runtimeSettings.containerImage)('delegates from the real member PATH with binary streams, isolated credentials, owned files and fresh revocation', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'platform-execution-')), secret = randomUUID(), secretId = randomUUID(), runtime = runtimeSection(root, 'https://example.test', runtimeSettings)
  const overlay = join(root, 'shell-observer.json')
  await writeFile(overlay, JSON.stringify([{ id: 'tools', config: { mode: 'native' } }, { insert: [{ id: 'execution-observer', name: '/dsh-phalanx/home/observer.mjs' }] }]))
  const legacy = [{ username: 'historic', owner: 'skill:news', command: 'news-cli', startedAt: Date.now() - 1000, durationMs: 3, exitCode: 0 }]
  await mkdir(join(root, 'execution'), { recursive: true })
  const legacyText = JSON.stringify([...legacy, ...legacy])
  await writeFile(join(root, 'execution/audit.json'), legacyText)
  let browser: Browser | undefined
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'execution-container-test-session-secret', runtime: { ...runtime, patches: [overlay] } })
  const cli = runtimeSettings.containerRuntimeCli
  const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  let testFailure: unknown
  const cleanup = async () => {
    const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), []), failures: unknown[] = []
    for (const action of [() => browser?.close(), () => app.stop(), () => new CommunityRuntimeDriver(runtime).rebuild(),
      () => new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([]), () => artifacts.collect([]),
      () => new FileExecutionArtifacts(join(root, 'execution/artifacts')).collect([]), () => rm(root, { recursive: true, force: true })]) {
      try { await action() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(testFailure === undefined ? failures : [testFailure, ...failures], 'Platform execution fixture cleanup failed')
  }
  try {
    const origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
    expect(bootstrap.status).toBe(303); const admin = cookies(bootstrap)
    const api = async (path: string, input?: unknown) => {
      const response = await fetch(origin + '/admin/api/' + path, { method: input ? 'POST' : 'GET', headers: { origin, cookie: admin, 'content-type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) })
      expect(response.status, await response.clone().text()).toBeLessThan(300); return response.json()
    }
    const group = (await api('groups')).find((row: { isDefault: boolean }) => row.isDefault)
    const member = await api('accounts', { username: 'member', email: '', password: 'password', groupId: group.id })
    const script = `#!/usr/bin/env node\nconst fs=require('node:fs');const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{fs.writeFileSync('owned-result.txt','created');process.stdout.write(JSON.stringify({credential:!!process.env.NEWS_KEY,secondCredential:!!process.env.MPS_SECRET_ID,memberEnvironment:process.env.MEMBER_PRIVATE ?? null,argv:process.argv.slice(2)})+'\\n');process.stdout.write(Buffer.concat(chunks));process.stderr.write('fixture-stderr');process.exitCode=7});\n`
    const upload = await fetch(origin + '/admin/api/skills/upload', { method: 'POST', headers: { origin, cookie: admin, 'content-type': 'application/zip' }, body: new Uint8Array(skillZip([{ path: 'SKILL.md', content: '---\nname: news\ndescription: Controlled news CLI\n---\nRun news-cli.' }, { path: 'bin/news-cli', content: script }, { path: 'scripts/hold.js', content: "const fs=require('node:fs');fs.writeFileSync('execution-started','ready');const timer=setInterval(()=>{if(fs.existsSync('execution-release')){clearInterval(timer);console.log('FINISHED')}},50)" }, { path: 'query.sh', content: '#!/bin/sh\nprintf ROOT_SCRIPT_OK\n' }, { path: 'scripts/news.js', content: script.split('\n').slice(1).join('\n') }, { path: 'scripts/news.py', content: 'import os, sys\nprint("PYTHON_AUTHORIZED" if os.environ.get("NEWS_KEY") else "MISSING")\nsys.exit(7)\n' }])) })
    expect(upload.status).toBe(200); const preview = await upload.json()
    await api('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })
    const grantPath = `groups/${group.id}/skills`, grant = await api(grantPath)
    await api(grantPath, { action: 'save', names: ['news'], revision: grant.revision, confirmed: true })
    const configuration = { enabled: true, commands: [{ command: 'news-cli', blocked: ['apikey-get'] }, { command: 'scripts/news.js', blocked: [] }, { command: 'scripts/news.py', blocked: [] }, { command: './query.sh', blocked: [] }, { command: 'scripts/hold.js', blocked: [] }], variables: [{ name: 'NEWS_KEY', value: secret, secret: true }, { name: 'MPS_SECRET_ID', value: secretId, secret: true }] }
    expect(JSON.stringify(await api('skills/execution?name=news', configuration))).not.toContain(secret)
    await expect.poll(async () => (await api('skills/execution?name=news')).preparation?.stage).toBe('ready')
    await mkdir(join(root, 'users/member/home'), { recursive: true, mode: 0o700 })
    await copyFile('tests/fixtures/skill-observer.mjs', join(root, 'users/member/home/observer.mjs'))
    const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'member', password: 'password' }) })
    expect(login.status).toBe(303); expect(login.headers.get('location')).not.toBe('/recovery')
    const memberCookie = (await openCommunityHttpEntry(origin, cookies(login), 300_000)).cookie
    const observe = async (body: object) => {
      const response = await fetch(communityEntryUrl(origin, memberCookie) + 'skills-fixture', { method: 'POST', headers: { origin, cookie: memberCookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect(response.status).toBe(200); return response.json()
    }
    const { sessionId } = await observe({ operation: 'create' })
    const native = (await observe({ operation: 'tool', sessionId, name: 'bash', args: { description: 'Run delegated command', command: 'news-cli native', timeoutMs: 10000 } })).value
    expect(native.exitCode, native.stderr.text).toBe(7)
    expect(JSON.parse(native.stdout.text)).toMatchObject({ credential: true, secondCredential: true, argv: ['native'] })
    const ownership = createHash('sha256').update(root).digest('hex')
    let container = (await execFileText(cli, ['ps', '--filter', `label=dsh-phalanx.community-root=${ownership}`, '--filter', 'label=dsh-phalanx.user=member', '--format', '{{.Names}}'])).trim()
    expect(container).not.toBe('')
    const execute = async (command: string, stdin = Buffer.alloc(0)) => {
      const child = spawn(cli, ['exec', '--interactive', '--workdir', '/dsh-phalanx/workspace', '--env', 'MEMBER_PRIVATE=must-not-forward', container, 'sh', '-c', command])
      const stdout: Buffer[] = [], stderr: Buffer[] = []
      child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk)); child.stdin.end(stdin)
      const code = await new Promise<number | null>((done, fail) => { child.once('error', fail); child.once('close', done) })
      return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() }
    }
    expect((await execute('command -v news-cli')).stdout.toString().trim()).toBe('/dsh-phalanx/member-skills/commands/live/news-cli')
    const blocked = await execute('news-cli apikey-get')
    expect(blocked.code).toBe(0); expect(blocked.stdout.toString()).toBe('API Key: Credentials are configured by the platform / 凭据由平台配置。\n'); expect(blocked.stderr).toBe('')
    const input = Buffer.from([0, 255, 1, 10, 128]), result = await execute('news-cli hot "two words"', input)
    expect(result.code, result.stderr).toBe(7); expect(result.stderr).toBe('fixture-stderr')
    const line = result.stdout.indexOf(10)
    expect(JSON.parse(result.stdout.subarray(0, line).toString())).toEqual({ credential: true, secondCredential: true, memberEnvironment: null, argv: ['hot', 'two words'] })
    expect(result.stdout.subarray(line + 1)).toEqual(input)
    expect(await readFile(join(root, 'users/member/workspace/owned-result.txt'), 'utf8')).toBe('created')
    expect((await stat(join(root, 'users/member/workspace/owned-result.txt'))).uid).toBe(process.getuid!())
    expect((await execute('node /dsh-phalanx/member-skills/live/news/scripts/news.js hot', input)).code).toBe(7)
    const hook = "import os\nopen('/dsh-phalanx/home/leaked-key.txt','w').write(os.environ.get('NEWS_KEY','none'))\n"
    const createHook = `import pathlib,sys; p=pathlib.Path('/dsh-phalanx/home/.local/lib')/('python'+str(sys.version_info.major)+'.'+str(sys.version_info.minor))/'site-packages';p.mkdir(parents=True,exist_ok=True);(p/'usercustomize.py').write_text(${JSON.stringify(hook)})`
    expect((await execute('python3 -c ' + "'" + createHook.replaceAll("'", "'\\''") + "'")).code).toBe(0)
    const python = await execute('python3 /dsh-phalanx/member-skills/live/news/scripts/news.py')
    expect(python.code, python.stderr).toBe(7); expect(python.stdout.toString()).toBe('PYTHON_AUTHORIZED\n')
    // The member's own Python wrapper may run its hook without credentials; the trusted execution must never write the key.
    try { expect(await readFile(join(root, 'users/member/home/leaked-key.txt'), 'utf8')).not.toBe(secret) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }

    const defaults = await api('execution/settings')
    expect(defaults.isolated).toBe(true)
    await api('execution/settings', { ...defaults.limits, memberConcurrency: 1, platformConcurrency: 1, timeoutSeconds: 2, memoryMiB: 256, cpus: 0.5, pids: 32 })
    const holding = execute('node /dsh-phalanx/member-skills/live/news/scripts/hold.js')
    await expect.poll(async () => { try { return await readFile(join(root, 'users/member/workspace/execution-started'), 'utf8') } catch { return '' } }).toBe('ready')
    const concurrent = await execute('news-cli hot')
    expect(concurrent.code).toBe(125); expect(concurrent.stderr).toContain('DSH_PHALANX_EXECUTION[concurrency]')
    const timed = await holding
    expect(timed.code).toBe(125); expect(timed.stderr).toContain('DSH_PHALANX_EXECUTION[timeout]')
    await api('execution/settings', defaults.limits)
    const records = (await api('usage-records?username=member&capability=skill:news')).items
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'timeout' }), expect.objectContaining({ reason: 'concurrency' }), expect.objectContaining({ capability: expect.objectContaining({ operation: 'news-cli', firstArgument: 'apikey-get' }), exitCode: 0, outcome: 'denied', reason: 'blocked' })]))
    expect(JSON.stringify(records)).not.toMatch(/argv|stdout|stderr|stdin|two words|MEMBER_PRIVATE/)
    for (const value of [secret, secretId]) expect(JSON.stringify(records)).not.toContain(value)
    expect(records.some((row: { groupId: string }) => row.groupId === group.id)).toBe(true)
    const history = await api('usage-records?username=historic')
    expect(history.items).toHaveLength(2); expect(history.items.every((row: { groupId: string | null, capability: { firstArgument?: string } }) => row.groupId === null && row.capability.firstArgument === undefined)).toBe(true)
    expect((await fetch(origin + '/admin/api/execution/records', { headers: { cookie: admin } })).status).toBe(404)
    expect((await fetch(origin + '/admin/execution-records', { headers: { cookie: admin } })).status).toBe(404)
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(30000)
    await signInCommunity(page, origin, 'admin', 'password', true)
    await page.goto(origin + '/admin/usage-records')
    await page.getByLabel('Filter by member', { exact: true }).fill('member')
    await page.getByLabel('Filter by capability', { exact: true }).fill('skill:news')
    await page.getByLabel('Filter by operation', { exact: true }).fill('news-cli')
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
    const grid = page.getByRole('grid', { name: 'Tool usage records', exact: true })
    for (const name of ['Duration', 'First argument', 'Exit code', 'Failure reason']) await grid.getByRole('columnheader', { name, exact: true }).waitFor()
    await grid.getByText('native', { exact: true }).waitFor()
    await grid.getByText('Command blocked', { exact: true }).waitFor()
    expect(await page.getByRole('link', { name: 'Platform execution records', exact: true }).count()).toBe(0)
    const trial = await api('execution/trial', { owner: 'skill:news', line: 'news-cli trial' })
    expect(trial.exitCode).toBe(7)
    expect(await readFile(join(root, 'users/admin/workspace/owned-result.txt'), 'utf8')).toBe('created')
    expect((await execute('sh /dsh-phalanx/member-skills/live/news/query.sh')).stdout.toString()).toBe('ROOT_SCRIPT_OK')
    expect((await execute(`cp /dsh-phalanx/member-skills/live/news/query.sh ${CONTAINER_HOME}/retained-query.sh`)).code).toBe(0)
    expect((await execute(`cp /dsh-phalanx/member-skills/live/news/scripts/news.py ${CONTAINER_HOME}/retained-python.py`)).code).toBe(0)
    const replacementResponse = await fetch(origin + '/admin/api/skills/upload', { method: 'POST', headers: { origin, cookie: admin, 'content-type': 'application/zip' }, body: new Uint8Array(skillZip([{ path: 'SKILL.md', content: '---\nname: news\ndescription: Updated controlled CLI\n---\nRun news-cli.' }, { path: 'bin/news-cli', content: script }])) })
    expect(replacementResponse.status).toBe(200)
    const replacement = await replacementResponse.json()
    await api('skills/change', { action: 'confirm', token: replacement.token, revision: replacement.revision })
    const updated = await api('skills/execution?name=news')
    expect(updated.commands).toEqual(configuration.commands)
    expect(updated.variables).toEqual([{ name: 'NEWS_KEY', secret: true, configured: true }, { name: 'MPS_SECRET_ID', secret: true, configured: true }])
    expect(updated.unavailableCommands).toEqual(['scripts/news.js', 'scripts/news.py', './query.sh', 'scripts/hold.js'])
    const rootRemoved = await execute(`sh ${CONTAINER_HOME}/retained-query.sh`)
    expect(rootRemoved.code).toBe(125); expect(rootRemoved.stderr).toContain('DSH_PHALANX_EXECUTION[command-missing]')
    const removed = await execute(`python3 ${CONTAINER_HOME}/retained-python.py`)
    expect(removed.code).toBe(125); expect(removed.stderr).toContain('DSH_PHALANX_EXECUTION[command-missing]')
    await expect.poll(async () => (await api('skills/execution?name=news')).preparation?.stage).toBe('ready')
    expect((await execute('news-cli hot')).code).toBe(7)
    expect((await execute(`cp /dsh-phalanx/member-skills/commands/live/news-cli ${CONTAINER_HOME}/retained-forwarder`)).code).toBe(0)
    await api('accounts/member/reset-environment', { confirmed: true })
    container = (await execFileText(cli, ['ps', '--filter', `label=dsh-phalanx.community-root=${ownership}`, '--filter', 'label=dsh-phalanx.user=member', '--format', '{{.Names}}'])).trim()
    expect((await execute('news-cli hot')).code).toBe(7)
    const files = [join(root, 'users/member'), join(root, 'skills/members', member.spaceId)]
    const scan = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await scan(path)
        else if (entry.isFile()) { const bytes = await readFile(path); for (const value of [secret, secretId]) expect(bytes.includes(Buffer.from(value)), path).toBe(false) }
      }
    }
    for (const path of files) await scan(path)
    await api('skills/execution?name=news', { ...configuration, enabled: false, variables: [{ name: 'NEWS_KEY', secret: true }] })
    const disabled = await execute(`sh ${CONTAINER_HOME}/retained-forwarder hot`)
    expect(disabled.code).toBe(125); expect(disabled.stderr).toContain('DSH_PHALANX_EXECUTION[disabled]')
    await api('skills/execution?name=news', configuration)
    const changed = await api(grantPath); await api(grantPath, { action: 'save', names: [], revision: changed.revision, confirmed: true })
    const revoked = await execute(`sh ${CONTAINER_HOME}/retained-forwarder hot`)
    expect(revoked.code).toBe(125); expect(revoked.stderr).toContain('DSH_PHALANX_EXECUTION[unauthorized]')
    const restore = await api(grantPath); await api(grantPath, { action: 'save', names: ['news'], revision: restore.revision, confirmed: true })
    await api('accounts/member/actions', { action: 'set-disabled', disabled: true })
    // Account disable may stop the member container; its directory is removed regardless.
    await expect(readdir(join(root, 'skills/members', member.spaceId))).rejects.toMatchObject({ code: 'ENOENT' })
    const auditBeforeDelete = await api('usage-records?username=member')
    await api('accounts/member/actions', { action: 'delete' })
    expect(await api('usage-records?username=member')).toEqual(auditBeforeDelete)
    expect(await readFile(join(root, 'execution/audit.json'), 'utf8')).toBe(legacyText)
    const detail = await api('skills/detail?name=news')
    await api('skills/change', { action: 'remove', name: 'news', revision: detail.revision })
    const privateConfiguration = await readFile(join(root, 'execution/configuration.json'), 'utf8')
    for (const value of [secret, secretId]) expect(privateConfiguration).not.toContain(value)
    expect(await readdir(join(root, 'execution/artifacts')).catch(error => { if (error.code === 'ENOENT') return []; throw error })).toEqual([])
  } catch (error) { testFailure = error; throw error }
  finally { await cleanup() }
}, 360000)
