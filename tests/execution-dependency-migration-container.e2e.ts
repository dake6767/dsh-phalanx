// Validation: T2 + T4; real credentials: none for module migration; NEWS_KEY_FILE for real-news migration (T4 only). T2 selects the exact no-key title.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillLibraryStore } from '../src/adapters/skill-library-store.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { FileExecutionConfigurations } from '../src/adapters/execution-configuration-store.js'
import { FileExecutionPreparations } from '../src/adapters/execution-preparation-store.js'
import { ContainerExecutionPreparer } from '../src/adapters/execution-preparer.js'
import { ContainerExecutionProcess } from '../src/adapters/execution-container-process.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { skillZip } from './fixtures/skills/archive.js'

it.skipIf(!runtimeSettings.containerImage || !process.env.NEWS_KEY_FILE)('migrates the real news installation without preparation credentials, falls back on failure and rotates execution credentials without rebuilding', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const key = (await readFile(process.env.NEWS_KEY_FILE!, 'utf8')).trim()
  expect(key.length > 0).toBe(true)
  const root = await mkdtemp(join(tmpdir(), 'execution-dependency-migration-')), runtime = runtimeSection(root, 'https://example.test', runtimeSettings)
  const sources = new FileSkillArtifacts(join(root, 'skills/artifacts'), []), oldArtifacts = new FileExecutionArtifacts(join(root, 'execution/artifacts'))
  const containerProcess = new ContainerExecutionProcess(runtime), preparer = new ContainerExecutionPreparer(runtime, containerProcess, sources, oldArtifacts)
  let app: ReturnType<typeof candidateApplication> | undefined
  try {
    const skill = await sources.accept((async function* () { yield skillZip([{ path: 'SKILL.md', content: '---\nname: news\ndescription: News migration\n---\nUse tencent-news-cli hot.' }]) })(), new AbortController().signal)
    new FileSkillLibraryStore(join(root, 'skills/library.json')).save({ name: skill.name, description: skill.description, hash: skill.hash, importedAt: 0, published: false })
    const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
    await accounts.createFirstAdmin({ username: 'admin', password: 'password', email: '' }); accounts.close()
    const install = 'set -eu; mkdir -p bin; curl -fsSL https://mat1.gtimg.com/qqcdn/qqnews/cli/hub/tencent-news/setup.sh -o /tmp/news-setup.sh; TENCENT_NEWS_INSTALL="$PWD/.news" sh /tmp/news-setup.sh; cp .news/bin/tencent-news-cli bin/tencent-news-cli'
    const configuration = { enabled: true, commands: [{ command: 'tencent-news-cli', blocked: ['apikey-get', 'apikey-set', 'apikey-clear', 'update'] }], variables: [{ name: 'TENCENT_NEWS_APIKEY', value: key, secret: true }], prepare: 'test -n "$TENCENT_NEWS_APIKEY" || exit 29; ' + install }
    const owner = { id: 'skill:news', version: skill.hash }
    await preparer.recover()
    const old = await preparer.prepare(owner, configuration, new AbortController().signal)
    new FileExecutionConfigurations(join(root, 'execution/configuration.json')).save(owner.id, configuration)
    new FileExecutionPreparations(join(root, 'execution/preparations.json')).save(owner.id, { identity: old.hash, stage: 'ready', updatedAt: 1, log: old.log, artifact: old })
    await containerProcess.stop()
    app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'execution-migration-fixture-secret-32', runtime })
    let origin = await app.start()
    const login = async () => { const response = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password: 'password' }) }); expect(response.status).toBe(303); return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }
    let cookie = await login()
    const api = async (path: string, input?: unknown) => { const response = await fetch(origin + '/admin/api/' + path, { method: input ? 'POST' : 'GET', headers: { origin, cookie, 'content-type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) }); expect(response.ok).toBe(true); return response.json() }
    await expect.poll(async () => (await api('runtime-dependencies'))[0]?.stage, { timeout: 30000 }).toBe('failed')
    const dependency = (await api('runtime-dependencies'))[0]
    expect(dependency.source).toBe('migration-0.1.10'); expect(dependency.references).toEqual([{ kind: 'execution', name: owner.id }])
    expect(dependency.log.includes(key)).toBe(false)
    expect(await api('skills/execution?name=news')).toMatchObject({ runtimeDependencies: [dependency.name], preparation: { usingPrevious: true } })
    expect(await readFile(join(root, 'execution/configuration.json'), 'utf8')).not.toContain('"prepare":')
    const trial = () => api('execution/trial', { owner: owner.id, line: 'tencent-news-cli hot' })
    const fallback = await trial(); expect(fallback.exitCode).toBe(0); expect(fallback.stdout.length > 100).toBe(true); expect(JSON.stringify(fallback).includes(key)).toBe(false)
    await app.stop(); app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'execution-migration-fixture-secret-32', runtime }); origin = await app.start(); cookie = await login()
    expect(await api('runtime-dependencies')).toHaveLength(1)
    await api('runtime-dependencies', { action: 'update', name: dependency.name, input: { name: dependency.name, prepareCommand: install, pathDirectories: ['bin'], checkCommand: 'tencent-news-cli help' } })
    await expect.poll(async () => (await api('runtime-dependencies'))[0]?.stage, { timeout: 120000 }).toBe('ready')
    const current = (await api('runtime-dependencies'))[0].current.id
    const migrated = await trial(); expect(migrated.exitCode).toBe(0); expect(migrated.stdout.length > 100).toBe(true); expect(JSON.stringify(migrated).includes(key)).toBe(false)
    const saved = await api('skills/execution?name=news')
    await api('skills/execution?name=news', { ...saved, variables: [{ name: 'TENCENT_NEWS_APIKEY', secret: true, value: 'invalid-rotation-fixture' }] })
    const rejected = await trial(); expect(rejected.exitCode).not.toBe(0)
    expect((await api('runtime-dependencies'))[0].current.id).toBe(current)
    await api('skills/execution?name=news', { ...saved, variables: [{ name: 'TENCENT_NEWS_APIKEY', secret: true, value: key }] })
    expect((await trial()).exitCode).toBe(0)
    expect((await api('runtime-dependencies'))[0].current.id).toBe(current)
    expect(JSON.stringify(await api('skills/execution?name=news')).includes(key)).toBe(false)
  } finally {
    await app?.stop(); await containerProcess.stop()
    await new FileSkillDistribution(join(root, 'skills/members'), sources).synchronize([])
    await sources.collect([]); await oldArtifacts.collect([]); await new FileExecutionArtifacts(join(root, 'runtime-dependencies/.trees')).collect([])
    await rm(root, { recursive: true, force: true })
  }
}, 300000)

it.skipIf(!runtimeSettings.containerImage)('preserves Node module resolution for migrated skill scripts and prepares updated skill sources', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'execution-module-migration-')), runtime = runtimeSection(root, 'https://example.test', runtimeSettings)
  const sources = new FileSkillArtifacts(join(root, 'skills/artifacts'), []), oldArtifacts = new FileExecutionArtifacts(join(root, 'execution/artifacts'))
  const containerProcess = new ContainerExecutionProcess(runtime), preparer = new ContainerExecutionPreparer(runtime, containerProcess, sources, oldArtifacts)
  let app: ReturnType<typeof candidateApplication> | undefined
  const archive = (prefix: string) => skillZip([{ path: 'SKILL.md', content: '---\nname: module-skill\ndescription: Module migration\n---\nRun scripts/main.js.' }, { path: 'scripts/main.js', content: `console.log('${prefix}' + require('migration-module').value)` }])
  try {
    const skill = await sources.accept((async function* () { yield archive('OLD_') })(), new AbortController().signal)
    new FileSkillLibraryStore(join(root, 'skills/library.json')).save({ name: skill.name, description: skill.description, hash: skill.hash, importedAt: 0, published: false })
    const accounts = new CommunityAccountStore(join(root, 'community-accounts.db')); await accounts.createFirstAdmin({ username: 'admin', password: 'password', email: '' }); accounts.close()
    const configuration = { enabled: true, commands: [{ command: 'scripts/main.js', blocked: [] }], variables: [], prepare: `mkdir -p node_modules/migration-module bin; printf 'exports.value="MODULE_OK";\n' > node_modules/migration-module/index.js; printf '#!/bin/sh\necho helper\n' > bin/module-helper; chmod +x bin/module-helper` }
    const owner = { id: 'skill:module-skill', version: skill.hash }
    await preparer.recover(); const old = await preparer.prepare(owner, configuration, new AbortController().signal)
    new FileExecutionConfigurations(join(root, 'execution/configuration.json')).save(owner.id, configuration)
    new FileExecutionPreparations(join(root, 'execution/preparations.json')).save(owner.id, { identity: old.hash, stage: 'ready', updatedAt: 1, log: '', artifact: old }); await containerProcess.stop()
    app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'execution-module-fixture-secret-32', runtime })
    const origin = await app.start()
    const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password: 'password' }) })
    expect(login.status).toBe(303); const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const api = async (path: string, input?: unknown) => { const response = await fetch(origin + '/admin/api/' + path, { method: input ? 'POST' : 'GET', headers: { origin, cookie, 'content-type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) }); expect(response.ok, await response.clone().text()).toBe(true); return response.json() }
    await expect.poll(async () => (await api('runtime-dependencies'))[0]?.stage, { timeout: 30000 }).toBe('ready')
    const previous = (await api('runtime-dependencies'))[0].current.id
    expect(await api('execution/trial', { owner: owner.id, line: 'scripts/main.js' })).toMatchObject({ exitCode: 0, stdout: 'OLD_MODULE_OK\n' })
    const upload = await fetch(origin + '/admin/api/skills/upload', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/zip' }, body: new Uint8Array(archive('NEW_')) })
    expect(upload.status).toBe(200); const preview = await upload.json()
    await api('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })
    await expect.poll(async () => { const row = (await api('runtime-dependencies'))[0]; return row.stage === 'ready' && row.current.id !== previous }, { timeout: 30000 }).toBe(true)
    expect(await api('execution/trial', { owner: owner.id, line: 'scripts/main.js' })).toMatchObject({ exitCode: 0, stdout: 'NEW_MODULE_OK\n' })
  } finally {
    await app?.stop(); await containerProcess.stop(); await new FileSkillDistribution(join(root, 'skills/members'), sources).synchronize([])
    await sources.collect([]); await oldArtifacts.collect([]); await new FileExecutionArtifacts(join(root, 'runtime-dependencies/.trees')).collect([]); await rm(root, { recursive: true, force: true })
  }
}, 120000)
