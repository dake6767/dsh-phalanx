// Manual Linux diagnostic for the formal-upgrade baseline trial; no real credentials.
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { skillZip } from './fixtures/skills/archive.js'
import { withAdministratorSkill, retainedExecutionTrial } from './support/installed-upgrade-trial.js'

it('runs the retained dependency command with the formal-upgrade administrator preconditions', async () => {
  expect(process.platform, 'Requires actual Linux').toBe('linux')
  expect(runtimeSettings.containerImage, 'Requires an actual container image').toBeTruthy()
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'upgrade-trial-'))
  const runtime = runtimeSection(root, 'https://example.test', runtimeSettings)
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'upgrade-trial-fixture-session-secret', runtime })
  try {
    const origin = await app.start()
    const response = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
    expect(response.status).toBe(303)
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const request = (path: string, input?: unknown) => fetch(origin + '/admin/api/' + path, { method: input ? 'POST' : 'GET', headers: { origin, cookie, 'content-type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) })
    const api = async (path: string, input?: unknown) => { const r = await request(path, input); expect(r.status, await r.clone().text()).toBeLessThan(300); return r.json() }
    await api('runtime-dependencies', { action: 'create', input: { name: 'retained-tools', prepareCommand: 'mkdir bin; printf "#!/bin/sh\\necho retained\\n" > bin/retained; chmod +x bin/retained', pathDirectories: ['bin'], checkCommand: 'retained' } })
    await expect.poll(async () => (await api('runtime-dependencies?name=retained-tools')).stage).toBe('ready')
    const upload = await fetch(origin + '/admin/api/skills/upload', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/zip' }, body: new Uint8Array(skillZip([{ path: 'SKILL.md', content: '---\nname: retained-skill\ndescription: Retained upgrade fixture\n---\nRetained.' }])) })
    expect(upload.status).toBe(200); const preview = await upload.json()
    await api('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })
    const detail = await api('skills/detail?name=retained-skill')
    await api('skills/change', { action: 'runtime-dependencies', name: detail.name, names: ['retained-tools'], revision: detail.revision })
    await api('skills/execution?name=retained-skill', { enabled: true, commands: [{ command: 'retained', blocked: [] }], variables: [], runtimeDependencies: ['retained-tools'] })
    await expect.poll(async () => (await api('skills/execution?name=retained-skill')).preparation?.stage).toBe('ready')
    const trial = await api('execution/trial', { owner: 'skill:retained-skill', line: 'retained' })
    await writeFile(join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR!, 'baseline-trial.json'), JSON.stringify(trial) + '\n')
    expect(trial).toMatchObject({ exitCode: 125, stdout: '', stderr: expect.stringContaining('[unauthorized]') })
    const group = (await api('groups')).find((row: { kind: string }) => row.kind === 'admin')
    const grantPath = `groups/${group.id}/skills`, before = await api(grantPath)
    const trialApi = { get: (path: string) => api(path), post: async (path: string, value: unknown) => { const r = await request(path, value); return { status: () => r.status, json: () => r.json() } } }
    await withAdministratorSkill(trialApi, 'retained-skill', () => retainedExecutionTrial(trialApi, 'authorized', join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR!, 'authorized-trial.jsonl'), value => value))
    const after = await api(grantPath)
    for (const key of ['skills', 'packs']) expect(after[key]).toEqual(before[key])
    expect(await api('execution/trial', { owner: 'skill:retained-skill', line: 'retained' })).toMatchObject({ exitCode: 125, stderr: expect.stringContaining('[unauthorized]') })
    await expect(withAdministratorSkill(trialApi, 'retained-skill', async () => { throw new Error('fixture trial failure') })).rejects.toThrow('fixture trial failure')
    const restored = await api(grantPath)
    for (const key of ['skills', 'packs']) expect(restored[key]).toEqual(before[key])
  } finally {
    await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    await execFileText('chmod', ['-R', 'u+w', root], { timeout: 30000 })
    await rm(root, { recursive: true, force: true })
  }
}, 300000)
