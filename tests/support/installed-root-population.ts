import { cleanupOwned } from '../fixtures/owned-cleanup.js'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { packExpertPlugin } from '../fixtures/expert-plugin.js'
import { gitFixture } from '../fixtures/skills/git-repository.js'
import { validSkill } from '../fixtures/skills/archive.js'
import { installedProjectionControl } from './installed-projection-control.js'

type Json = Awaited<ReturnType<Response['json']>>
interface Input {
  workRoot: string
  adminCookie: string
  groupId: string
  api(path: string, input?: unknown): Promise<Json>
  call(path: string, init?: RequestInit): Promise<Response>
  progress(stage: string): void
}

/** Populate current producers through the exact installed platform, without injected preparers or trust keys. */
export async function populateInstalledRoot({ workRoot, adminCookie, groupId, api, call, progress }: Input) {
  progress('plugin-upload')
  const plugin = await packExpertPlugin(workRoot, 'healthy')
  const uploaded = await call('/admin/api/plugins/upload', {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/gzip', 'x-plugin-filename': 'milestone.tgz' },
    body: new Uint8Array(await readFile(plugin.archive)),
  })
  expect(uploaded.status).toBe(202)
  await expect
    .poll(async () => (await api('plugins')).find((row: { packageName: string }) => row.packageName === plugin.packageName)?.stage, { timeout: 180000 })
    .toBe('available')
  const grantPath = 'groups/' + groupId + '/plugins',
    grant = await api(grantPath)
  await api(grantPath, {
    action: 'save',
    packages: [...grant.plugins.filter((row: { granted: boolean }) => row.granted).map((row: { packageName: string }) => row.packageName), plugin.packageName],
    preinstalls: [],
    revision: grant.revision,
  })
  progress('git-import')
  const git = await gitFixture()
  try {
    await git.commit({ 'SKILL.md': validSkill.replaceAll('example-skill', 'installed-git-skill') })
    await installedProjectionControl(workRoot, { action: 'configure-git', proxy: git.proxy, caFile: git.caFile })
    const preview = await api('skills/import/git', { source: git.url })
    await api('skills/import/confirm', { token: preview.token, names: ['installed-git-skill'], replacements: [], packs: [] })
    expect(git.connects()).toBeGreaterThan(0)
  } finally {
    await cleanupOwned(
      () => installedProjectionControl(workRoot, { action: 'restore-git' }),
      () => git.close(),
    )
  }
  await installedProjectionControl(workRoot, {
    action: 'configure-catalog',
    address: 'https://github.com/dake6767/dsh-phalanx-catalog/releases/download/catalog-40075953922/catalog.json',
  })
  await api('suites')
  await api('suites', { action: 'install', input: { id: 'officecli', requestId: randomUUID(), groups: [groupId], publish: true } })
  await expect
    .poll(async () => (await api('suites')).installations.find((row: { id: string }) => row.id === 'officecli')?.status, { timeout: 900000, interval: 2000 })
    .toMatch(/^(installed|failed)$/u)
  expect((await api('suites')).installations.find((row: { id: string }) => row.id === 'officecli')?.status).toBe('installed')
  const skillsPath = 'groups/' + groupId + '/skills',
    skills = await api(skillsPath)
  await api(skillsPath, {
    action: 'save',
    names: [...skills.skills.filter((row: { granted: boolean }) => row.granted).map((row: { name: string }) => row.name), 'installed-git-skill'],
    packs: skills.packs.filter((row: { granted: boolean }) => row.granted).map((row: { name: string }) => row.name),
    revision: skills.revision,
    confirmed: true,
  })
  progress('expert-configuration')
  await api('experts', {
    revision: (await api('experts')).revision,
    expert: {
      name: 'Installed expert',
      description: 'Projection reconstruction',
      icon: 'I',
      persona: 'INSTALLED_EXPERT_PERSONA',
      skills: ['news', 'installed-git-skill'],
      skillPacks: [],
      plugins: [plugin.packageName],
      mcp: ['p-milestone'],
    },
  })
  const expert = (await api('experts')).experts.find((row: { name: string }) => row.name === 'Installed expert')
  await api('experts', { action: 'publish', id: expert.id, published: true, revision: (await api('experts')).revision, confirmed: true })
  return { expertId: expert.id as string, uploadedPlugin: plugin.packageName }
}
