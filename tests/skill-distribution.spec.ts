import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { skillZip } from './fixtures/skills/archive.js'

let root: string | undefined
afterEach(async () => { if (root) { await new FileSkillDistribution(join(root, 'members'), new FileSkillArtifacts(join(root, 'artifacts'), [])).synchronize([]); await new FileSkillArtifacts(join(root, 'artifacts'), []).collect([]); await rm(root, { recursive: true, force: true }) } })

it('publishes complete readonly generations, replaces contents and removes revoked and retired projections', async () => {
  root = await mkdtemp(join(tmpdir(), 'skill-projection-'))
  const artifacts = new FileSkillArtifacts(join(root, 'artifacts'), [])
  const upload = async (version: string) => {
    async function* bytes() { yield skillZip([{ path: 'SKILL.md', content: `---\nname: example\ndescription: Useful\n---\n${version}` }, { path: 'scripts/run.sh', content: `echo ${version}` }]) }
    return { ...await artifacts.accept(bytes(), new AbortController().signal), importedAt: 0, published: false }
  }
  const one = await upload('one'), two = await upload('two')
  const distribution = new FileSkillDistribution(join(root, 'members'), artifacts)
  await distribution.synchronize([{ spaceId: 'member-space', skills: [one] }])
  const live = join(root, 'members/member-space/live')
  expect(await readFile(join(live, 'example/scripts/run.sh'), 'utf8')).toBe('echo one')
  expect((await stat(join(live, 'example/scripts/run.sh'))).mode & 0o222).toBe(0)
  expect((await stat(join(live, 'example'))).mode & 0o222).toBe(0)
  await expect(distribution.synchronize([{ spaceId: 'member-space', skills: [{ ...two, hash: '0'.repeat(64) }] }])).rejects.toBeInstanceOf(Error)
  expect(await readFile(join(live, 'example/scripts/run.sh'), 'utf8')).toBe('echo one')
  await distribution.synchronize([{ spaceId: 'member-space', skills: [two] }])
  expect(await readFile(join(live, 'example/SKILL.md'), 'utf8')).toContain('two')
  expect((await readdir(join(root, 'members/member-space'))).filter(name => name.startsWith('generation-'))).toHaveLength(1)
  await new FileSkillDistribution(join(root, 'members'), artifacts).synchronize([{ spaceId: 'member-space', skills: [] }])
  expect(await readdir(live)).toEqual([])
  await distribution.synchronize([])
  expect(await readdir(join(root, 'members'))).toEqual([])
})
