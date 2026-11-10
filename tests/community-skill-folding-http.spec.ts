import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunitySkillDetail, CommunitySkillView } from '../src/domain/admin-contract.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'
import { createCommunityApplication } from './support/community-application.js'

let app: CommunityApplication | undefined, root: string | undefined
afterEach(async () => {
  await app?.stop()
  if (root) {
    const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
    await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([])
    await artifacts.collect([])
    await removeCommunityFixture(root)
  }
})

async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'community-skill-folding-http-'))
  app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'skill-folding-http-fixture-secret-32-bytes',
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  const origin = await app.start()
  const bootstrap = await fetch(origin + '/bootstrap', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }),
  })
  expect(bootstrap.status).toBe(303)
  const cookies = (response: Response) =>
    response.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ')
  const admin = cookies(bootstrap)
  const get = async (path: string) => {
    const response = await fetch(origin + '/admin/api/' + path, { headers: { cookie: admin } })
    expect(response.status).toBe(200)
    return response.json()
  }
  const post = async (path: string, data: unknown, cookie = admin) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(data) })
    expect(response.status).toBeGreaterThanOrEqual(200)
    expect(response.status).toBeLessThan(300)
    return response.json()
  }
  return { origin, admin, get, post, cookies }
}

it('marks top-level skills from global direct grants and selections without removing packed resources', async () => {
  const { origin, admin, get, post, cookies } = await fixture()
  const preview = await (
    await fetch(origin + '/admin/api/skills/import', {
      method: 'POST',
      headers: { cookie: admin, origin, 'content-type': 'application/zip' },
      body: new Uint8Array(
        skillZip(['solo', 'child', 'shared'].map(name => ({ path: `skills/${name}/SKILL.md`, content: validSkill.replace('example-skill', name) }))),
      ),
    })
  ).json()
  await post('/admin/api/skills/import/confirm', {
    token: preview.token,
    names: ['solo', 'child', 'shared'],
    replacements: [],
    packs: [
      { name: 'research', description: 'Research', skills: ['child', 'shared'] },
      { name: 'writing', description: 'Writing', skills: ['shared'] },
    ],
  })
  const check = async (expected: Record<string, boolean>) => {
    const rows: CommunitySkillView[] = await get('skills')
    const groupView = await get('groups/default/skills')
    expect(rows.map(row => row.name)).toEqual(['child', 'shared', 'solo'])
    for (const row of rows) {
      expect(row).toMatchObject({ topLevel: expected[row.name], description: 'A useful skill' })
      expect(groupView.skills.find((skill: { name: string }) => skill.name === row.name)).toMatchObject({ name: row.name, topLevel: expected[row.name] })
      const detail: CommunitySkillDetail = await get('skills/detail?name=' + row.name)
      expect(detail).toMatchObject({ name: row.name, topLevel: expected[row.name], packs: row.packs })
    }
    return rows
  }
  const hidden = { solo: true, child: false, shared: false }
  expect((await check(hidden)).find(row => row.name === 'shared')?.packs).toEqual(['research', 'writing'])
  const groups = await post('/admin/api/groups', { action: 'create', name: 'Empty research group' })
  const empty = groups.find((group: { name: string }) => group.name === 'Empty research group')
  const groupPath = 'groups/' + empty.id + '/skills'
  const grant = async (names: string[]) => {
    const current = await get(groupPath)
    expect(current.members).toBe(0)
    await post('/admin/api/' + groupPath, { action: 'save', names, packs: ['research'], revision: current.revision, confirmed: true })
  }
  await grant([])
  await check(hidden)
  const beforeOtherGrant = await get('groups/default/skills')
  await grant(['child'])
  expect((await get('groups/default/skills')).revision).toBe(beforeOtherGrant.revision)
  expect((await get(groupPath)).packs).toContainEqual(expect.objectContaining({ name: 'research', skills: ['child', 'shared'] }))
  await check({ ...hidden, child: true })
  await grant([])
  await check(hidden)
  const child = await get('skills/detail?name=child')
  await post('/admin/api/skills/change', { action: 'publish', name: 'child', published: true, revision: child.revision })
  const packs = await get('skill-packs')
  await post('/admin/api/skill-packs', {
    action: 'save',
    previousName: 'research',
    revision: packs.packs.find((pack: { name: string }) => pack.name === 'research').revision,
    pack: { name: 'research', description: 'Research', skills: ['child', 'shared'], instructions: '', published: true },
  })
  await post('/admin/api/skill-packs', { action: 'publish', name: 'research', published: true, revision: (await get('skill-packs')).revision })
  await post('/admin/api/accounts', { username: 'member', password: 'password', email: '' })
  const login = await fetch(origin + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'member', password: 'password' }),
  })
  expect(login.status).toBe(303)
  const member = cookies(login)
  await post('/market/api/skill-packs', { action: 'install', name: 'research' }, member)
  await check(hidden)
  await post('/market/api/skills', { action: 'install', name: 'child' }, member)
  await check({ ...hidden, child: true })
  await post('/market/api/skills', { action: 'uninstall', name: 'child' }, member)
  await check(hidden)
  for (const name of ['research', 'writing']) {
    const current = await get('skill-packs/detail?name=' + name)
    await post('/admin/api/skill-packs', {
      action: 'save',
      previousName: name,
      revision: current.revision,
      pack: { name, description: name, skills: name === 'research' ? ['child'] : [], instructions: '', published: current.published },
    })
    await check({ ...hidden, shared: name === 'writing' })
  }
})

it('folds member skills under visible packs while retaining hidden-parent entry points and content permissions', async () => {
  const { origin, admin, get, post, cookies } = await fixture()
  const preview = await (
    await fetch(origin + '/admin/api/skills/import', {
      method: 'POST',
      headers: { cookie: admin, origin, 'content-type': 'application/zip' },
      body: new Uint8Array(
        skillZip(
          ['offered', 'private-child', 'pack-child', 'shared', 'solo'].map(name => ({
            path: `skills/${name}/SKILL.md`,
            content: validSkill.replace('example-skill', name),
          })),
        ),
      ),
    })
  ).json()
  await post('/admin/api/skills/import/confirm', {
    token: preview.token,
    names: ['offered', 'private-child', 'pack-child', 'shared', 'solo'],
    replacements: [],
    packs: [
      { name: 'hidden-parent', description: 'Hidden parent', skills: ['offered', 'private-child', 'shared'] },
      { name: 'visible-parent', description: 'Visible parent', skills: ['pack-child', 'shared'] },
    ],
  })
  for (const name of ['offered', 'shared', 'solo']) {
    const skill = await get('skills/detail?name=' + name)
    await post('/admin/api/skills/change', { action: 'publish', name, published: true, revision: skill.revision })
  }
  const publishPack = async (published: boolean) => {
    const pack = await get('skill-packs/detail?name=visible-parent')
    await post('/admin/api/skill-packs', { action: 'publish', name: pack.name, published, revision: pack.revision })
  }
  await post('/admin/api/accounts', { username: 'member', password: 'password', email: '' })
  const login = await fetch(origin + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'member', password: 'password' }),
  })
  expect(login.status).toBe(303)
  const member = cookies(login)
  const market = async () => {
    const response = await fetch(origin + '/market/api/skills', { headers: { cookie: member } })
    expect(response.status).toBe(200)
    return response.json()
  }
  const denied = async (path: string, method = 'GET', data?: unknown) => {
    const response = await fetch(origin + path, {
      method,
      headers: { cookie: member, origin, 'content-type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    })
    expect(response.status).toBe(method === 'GET' ? 404 : 409)
  }
  let view = await market()
  expect(view.packs).toEqual([])
  expect(view.skills.map((row: { name: string }) => row.name)).toEqual(['offered', 'shared', 'solo'])
  for (const row of view.skills) expect(row).toMatchObject({ topLevel: true, packs: [], detailsAvailable: true })
  expect(JSON.stringify(view)).not.toContain('hidden-parent')
  await denied('/market/api/skills/detail?name=private-child')
  await denied('/market/api/skill-packs', 'POST', { action: 'install', name: 'hidden-parent' })
  await post('/market/api/skills', { action: 'install', name: 'offered' }, member)
  await publishPack(true)
  view = await market()
  expect(view.packs).toEqual([expect.objectContaining({ name: 'visible-parent', skills: ['pack-child', 'shared'] })])
  expect(view.skills.find((row: { name: string }) => row.name === 'pack-child')).toMatchObject({
    topLevel: false,
    selectable: false,
    detailsAvailable: false,
    packs: ['visible-parent'],
  })
  expect(view.skills.find((row: { name: string }) => row.name === 'shared')).toMatchObject({ topLevel: false, packs: ['visible-parent'] })
  expect(view.skills.find((row: { name: string }) => row.name === 'offered')).toMatchObject({ topLevel: true, selectedDirectly: true, packs: [] })
  expect(JSON.stringify(view)).not.toContain('hidden-parent')
  await denied('/market/api/skills/detail?name=pack-child')
  await denied('/market/api/skills', 'POST', { action: 'install', name: 'pack-child' })
  await post('/market/api/skill-packs', { action: 'install', name: 'visible-parent' }, member)
  expect((await market()).skills.find((row: { name: string }) => row.name === 'pack-child')).toMatchObject({
    source: 'selected',
    selectable: false,
    detailsAvailable: false,
  })
  await denied('/market/api/skills/detail?name=pack-child')
  await publishPack(false)
  view = await market()
  expect(view.packs).toEqual([])
  expect(view.skills.map((row: { name: string }) => row.name)).toEqual(['offered', 'shared', 'solo'])
  expect(view.skills.find((row: { name: string }) => row.name === 'shared')).toMatchObject({ topLevel: true, packs: [] })
  const grant = async (names: string[], packs: string[]) => {
    const current = await get('groups/default/skills')
    await post('/admin/api/groups/default/skills', { action: 'save', names, packs, revision: current.revision, confirmed: true })
  }
  await grant([], ['hidden-parent'])
  view = await market()
  expect(view.packs).toEqual([expect.objectContaining({ name: 'hidden-parent', source: 'managed' })])
  expect(view.skills.find((row: { name: string }) => row.name === 'private-child')).toMatchObject({
    source: 'managed',
    selectable: false,
    topLevel: false,
    detailsAvailable: false,
  })
  await denied('/market/api/skills/detail?name=private-child')
  await denied('/market/api/skills', 'POST', { action: 'install', name: 'private-child' })
  await grant(['private-child'], ['hidden-parent'])
  expect((await market()).skills.find((row: { name: string }) => row.name === 'private-child')).toMatchObject({
    topLevel: true,
    detailsAvailable: true,
    source: 'managed',
  })
  expect((await fetch(origin + '/market/api/skills/detail?name=private-child', { headers: { cookie: member } })).status).toBe(200)
  await grant([], [])
  expect((await market()).skills.map((row: { name: string }) => row.name)).toEqual(['offered', 'shared', 'solo'])
  await denied('/market/api/skills/detail?name=private-child')
})
