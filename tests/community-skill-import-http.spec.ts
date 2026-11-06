import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'
import { createCommunityApplication } from './support/community-application.js'
import { gitFixture } from './fixtures/skills/git-repository.js'

let application: CommunityApplication | undefined, root: string | undefined
let repository: Awaited<ReturnType<typeof gitFixture>> | undefined
afterEach(async () => {
  await application?.stop()
  await repository?.close()
  repository = undefined
  vi.unstubAllEnvs()
  if (root) {
    await new FileSkillArtifacts(join(root, 'skills/artifacts'), []).collect([])
    await removeCommunityFixture(root)
  }
})

async function administration() {
  root = await mkdtemp(join(tmpdir(), 'community-skill-import-http-'))
  application = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'skill-import-http-fixture-secret-32-bytes',
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  const origin = await application.start()
  const bootstrap = await fetch(origin + '/bootstrap', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }),
  })
  expect(bootstrap.status).toBe(303)
  const cookie = bootstrap.headers
    .getSetCookie()
    .map(value => value.split(';')[0])
    .join('; ')
  return {
    preview: (bytes: Buffer) =>
      fetch(origin + '/admin/api/skills/import', {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/zip' },
        body: new Uint8Array(bytes),
      }),
    confirm: (value: unknown) =>
      fetch(origin + '/admin/api/skills/import/confirm', {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(value),
      }),
    list: async () => (await fetch(origin + '/admin/api/skills', { headers: { cookie } })).json(),
    git: (source: string, updateName?: string) =>
      fetch(origin + '/admin/api/skills/import/git', {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ source, ...(updateName ? { updateName } : {}) }),
      }),
  }
}

it('previews and imports valid siblings while reporting a malformed repository skill without relaxing YAML', async () => {
  const admin = await administration()
  const response = await admin.preview(
    skillZip([
      { path: 'README.md', content: 'Repository fixture' },
      { path: 'skills/alpha/SKILL.md', content: validSkill.replace('example-skill', 'alpha') },
      {
        path: 'skills/in-progress/software-factory/SKILL.md',
        content: '---\nname: software-factory\ndescription: Build software: plan and implement\n---\nInstructions\n',
      },
      { path: 'skills/beta/SKILL.md', content: validSkill.replace('example-skill', 'beta') },
      {
        path: '.claude-plugin/plugin.json',
        content: JSON.stringify({ name: 'workflow', skills: ['./skills/alpha', './skills/beta', './skills/in-progress/software-factory'] }),
      },
    ]),
  )
  expect(response.status).toBe(200)
  const preview = await response.json()
  expect(preview.candidates.map((row: { name: string }) => row.name)).toEqual(['alpha', 'beta'])
  expect(preview.failures).toEqual([
    expect.objectContaining({
      path: 'skills/in-progress/software-factory/SKILL.md',
      field: 'frontmatter',
      code: 'skill-frontmatter-invalid',
      reasonCode: 'yaml-invalid',
    }),
  ])
  expect(preview.packs).toEqual([{ name: 'workflow', description: 'workflow', skills: ['alpha', 'beta'] }])
  expect(await admin.list()).toEqual([])
  expect((await admin.confirm({ token: preview.token, names: ['alpha', 'beta'], replacements: [], packs: preview.packs })).status).toBe(200)
  expect((await admin.list()).map((row: { name: string }) => row.name)).toEqual(['alpha', 'beta'])
})

it('keeps the no-skills error and reports why every candidate could not be imported', async () => {
  const admin = await administration()
  const response = await admin.preview(
    skillZip([
      { path: 'README.md', content: 'Repository fixture' },
      { path: 'skills/bad/SKILL.md', content: '---\nname: bad\ndescription: Build software: plan and implement\n---\nInstructions\n' },
    ]),
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    code: 'skill-archive-invalid',
    failures: [{ path: 'skills/bad/SKILL.md', code: 'skill-frontmatter-invalid', field: 'frontmatter', reasonCode: 'yaml-invalid' }],
  })
  expect(await admin.list()).toEqual([])
})

it('reports the invalid frontmatter field and a stable reason for each skipped skill', async () => {
  const admin = await administration()
  const response = await admin.preview(
    skillZip([
      { path: 'README.md', content: 'Repository fixture' },
      { path: 'skills/good/SKILL.md', content: validSkill.replace('example-skill', 'good') },
      { path: 'skills/missing/SKILL.md', content: 'Instructions without frontmatter' },
      { path: 'skills/mapping/SKILL.md', content: '---\n- name\n- description\n---\nInstructions' },
      { path: 'skills/name/SKILL.md', content: validSkill.replace('example-skill', 'INVALID') },
      { path: 'skills/description/SKILL.md', content: validSkill.replace('A useful skill', '{ summary: text }') },
      { path: 'skills/legacy/SKILL.md', content: validSkill.replace('name:', 'disableModelInvocation: true\nname:') },
      { path: 'skills/boolean/SKILL.md', content: validSkill.replace('name:', 'disable-model-invocation: true\nuser-invocable: []\nname:') },
      { path: 'skills/bool-disable/SKILL.md', content: validSkill.replace('name:', 'user-invocable: true\ndisable-model-invocation: []\nname:') },
      { path: 'skills/legacy-model/SKILL.md', content: validSkill.replace('name:', 'modelInvocable: true\nname:') },
      { path: 'skills/legacy-user/SKILL.md', content: validSkill.replace('name:', 'userInvocable: true\nname:') },
      { path: 'skills/yaml/SKILL.md', content: validSkill.replace('name:', 'metadata: [unterminated\nname:') },
    ]),
  )
  expect(response.status).toBe(200)
  const preview = await response.json()
  expect(preview.candidates.map((row: { name: string }) => row.name)).toEqual(['good'])
  expect(preview.failures.map((row: { path: string; field: string; reasonCode: string }) => [row.path, row.field, row.reasonCode])).toEqual([
    ['skills/bool-disable/SKILL.md', 'disable-model-invocation', 'boolean-invalid'],
    ['skills/boolean/SKILL.md', 'user-invocable', 'boolean-invalid'],
    ['skills/description/SKILL.md', 'description', 'description-required'],
    ['skills/legacy-model/SKILL.md', 'modelInvocable', 'invocation-unsupported'],
    ['skills/legacy-user/SKILL.md', 'userInvocable', 'invocation-unsupported'],
    ['skills/legacy/SKILL.md', 'disableModelInvocation', 'invocation-unsupported'],
    ['skills/mapping/SKILL.md', 'frontmatter', 'mapping-required'],
    ['skills/missing/SKILL.md', 'frontmatter', 'frontmatter-required'],
    ['skills/name/SKILL.md', 'name', 'name-invalid'],
    ['skills/yaml/SKILL.md', 'frontmatter', 'yaml-invalid'],
  ])
})

it('refuses an oversized skill even when its frontmatter would otherwise be skipped', async () => {
  const admin = await administration()
  const response = await admin.preview(
    skillZip([
      { path: 'README.md', content: 'Repository fixture' },
      { path: 'skills/good/SKILL.md', content: validSkill.replace('example-skill', 'good') },
      { path: 'skills/bad/SKILL.md', content: '---\nname: bad\ndescription: invalid: YAML\n---\nInstructions' },
      { path: 'skills/bad/payload.txt', content: Buffer.alloc(20 * 1024 * 1024 + 1, 'x') },
    ]),
  )
  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({ code: 'skill-upload-too-large' })
  expect(await admin.list()).toEqual([])
})

it('refuses a bundled name even when that skill has an invalid description', async () => {
  const admin = await administration()
  const response = await admin.preview(
    skillZip([
      { path: 'README.md', content: 'Repository fixture' },
      { path: 'skills/good/SKILL.md', content: validSkill.replace('example-skill', 'good') },
      { path: 'skills/conflicting/SKILL.md', content: validSkill.replace('example-skill', 'office').replace('A useful skill', '{ summary: text }') },
    ]),
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: 'skill-builtin-conflict' })
  expect(await admin.list()).toEqual([])
})

it('keeps a malformed existing Git skill out of deletions while applying valid updates and true removals', async () => {
  repository = await gitFixture()
  await repository.commit({
    'README.md': 'Repository fixture',
    'skills/keep/SKILL.md': validSkill.replace('example-skill', 'keep'),
    'skills/updated/SKILL.md': validSkill.replace('example-skill', 'updated'),
    'skills/gone/SKILL.md': validSkill.replace('example-skill', 'gone'),
  })
  vi.stubEnv('HTTPS_PROXY', repository.proxy)
  vi.stubEnv('GIT_SSL_CAINFO', repository.caFile)
  const admin = await administration()
  const initial = await admin.git(repository.url)
  expect(initial.status).toBe(200)
  const first = await initial.json()
  expect((await admin.confirm({ token: first.token, names: ['keep', 'updated', 'gone'], replacements: [], packs: [] })).status).toBe(200)
  await repository.commit({
    'skills/keep/SKILL.md': '---\nname: keep\ndescription: invalid: YAML\n---\nInstructions',
    'skills/updated/SKILL.md': validSkill.replace('example-skill', 'updated').replace('A useful skill', 'Updated instructions'),
    'skills/gone/SKILL.md': null,
  })
  const changed = await admin.git(repository.url, 'updated')
  expect(changed.status).toBe(200)
  const preview = await changed.json()
  expect(preview.failures).toMatchObject([{ path: 'skills/keep/SKILL.md' }])
  expect(preview.deleted.map((row: { name: string }) => row.name)).toEqual(['gone'])
  expect((await admin.confirm({ token: preview.token, names: ['updated'], replacements: ['updated'], removals: ['gone'], packs: [] })).status).toBe(200)
  expect((await admin.list()).map((row: { name: string; description: string }) => [row.name, row.description])).toEqual([
    ['keep', 'A useful skill'],
    ['updated', 'Updated instructions'],
  ])
  await repository.commit({ 'skills/updated/SKILL.md': '---\nname: updated\ndescription: invalid: YAML\n---\nInstructions' })
  const invalid = await admin.git(repository.url, 'updated')
  expect(invalid.status).toBe(400)
  const failure = await invalid.json()
  expect(failure.code).toBe('skill-archive-invalid')
  expect(failure.failures.map((row: { path: string }) => row.path)).toEqual(['skills/keep/SKILL.md', 'skills/updated/SKILL.md'])
  expect((await admin.list()).map((row: { name: string }) => row.name)).toEqual(['keep', 'updated'])
  await repository.commit({ 'skills/keep/SKILL.md': null, 'skills/updated/SKILL.md': null })
  const removed = await admin.git(repository.url, 'updated')
  expect(removed.status).toBe(200)
  const empty = await removed.json()
  expect(empty.candidates).toEqual([])
  expect(empty.failures).toEqual([])
  expect(empty.deleted.map((row: { name: string }) => row.name)).toEqual(['keep', 'updated'])
  expect((await admin.confirm({ token: empty.token, names: [], replacements: [], removals: ['keep', 'updated'], packs: [] })).status).toBe(200)
  expect(await admin.list()).toEqual([])
})

it.each([
  { name: 'unsafe paths', files: () => [{ path: '../escape', content: 'unsafe' }], status: 400, code: 'skill-archive-invalid' },
  { name: 'case conflicts', files: () => [{ path: 'skills/GOOD/SKILL.md', content: validSkill }], status: 400, code: 'skill-archive-invalid' },
  { name: 'links', files: () => [{ path: 'skills/bad/link', content: '../../outside', mode: 0o120777 }], status: 400, code: 'skill-archive-invalid' },
  {
    name: 'file and directory conflicts',
    files: () => [{ path: 'skills/good/SKILL.md/child', content: 'unsafe' }],
    status: 400,
    code: 'skill-archive-invalid',
  },
  { name: 'invalid UTF-8', files: () => [{ path: 'skills/utf8/SKILL.md', content: Buffer.from([0xff]) }], status: 400, code: 'skill-archive-invalid' },
  {
    name: 'too many files',
    files: () => Array.from({ length: 10000 }, (_, index) => ({ path: `files/${index}.txt`, content: 'x' })),
    status: 400,
    code: 'skill-archive-invalid',
  },
  {
    name: 'total extracted capacity',
    files: () => [{ path: 'payload.bin', content: Buffer.alloc(100 * 1024 * 1024 + 1) }],
    status: 413,
    code: 'skill-upload-too-large',
  },
])('still rejects repository-wide $name before returning valid candidates', async ({ files, status, code }) => {
  const admin = await administration()
  const response = await admin.preview(
    skillZip([
      { path: 'README.md', content: 'Repository fixture' },
      { path: 'skills/good/SKILL.md', content: validSkill.replace('example-skill', 'good') },
      { path: 'skills/bad/SKILL.md', content: '---\nname: bad\ndescription: invalid: YAML\n---\nInstructions' },
      ...files(),
    ]),
  )
  expect(response.status).toBe(status)
  const error = await response.json()
  expect(error.code).toBe(code)
  expect(error.failures).toBeUndefined()
  expect(await admin.list()).toEqual([])
})
