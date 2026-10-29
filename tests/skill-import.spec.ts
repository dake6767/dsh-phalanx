import { expect, it } from 'vitest'
import { inspectSkillImport } from '../src/adapters/skill-import.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'

it('discovers safe sibling skills, orchestration hints, internal entries and value-free credential warnings', async () => {
  const result = await inspectSkillImport(
    skillZip([
      {
        path: 'bundle/meta/SKILL.md',
        content: validSkill
          .replace('example-skill', 'workflow')
          .replace('description: A useful skill', 'description: A useful skill\norchestration:\n  children: [one, two]'),
      },
      { path: 'bundle/one/SKILL.md', content: validSkill.replace('example-skill', 'one') },
      { path: 'bundle/one/.env', content: 'SERVICE_KEY=fictional-secret-should-never-be-in-a-warning' },
      {
        path: 'bundle/two/SKILL.md',
        content: validSkill.replace('example-skill', 'two').replace('description: A useful skill', 'description: A useful skill\nmetadata:\n  internal: true'),
      },
      { path: 'bundle/two/client.pem', content: '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----' },
    ]),
    [],
  )
  expect(result.candidates.map(row => [row.name, row.internal, row.orchestration])).toEqual([
    ['workflow', false, true],
    ['one', false, false],
    ['two', true, false],
  ])
  expect(result.candidates.find(row => row.name === 'one')?.warnings).toEqual([{ path: '.env', kind: 'filename' }])
  expect(JSON.stringify(result.candidates.map(row => row.warnings))).not.toContain('fictional-secret')
  expect(result.candidates.find(row => row.name === 'two')?.warnings).toEqual([
    { path: 'client.pem', kind: 'filename' },
    { path: 'client.pem', kind: 'content' },
  ])
  await expect(
    inspectSkillImport(
      skillZip([
        { path: 'one/SKILL.md', content: validSkill },
        { path: '../escape', content: 'bad' },
      ]),
      [],
    ),
  ).rejects.toMatchObject({ code: 'skill-archive-invalid' })
})

it('prioritizes a root skill, then container depth, then bounded fallback and deduplicates names', async () => {
  const file = (path: string, name: string) => ({ path, content: validSkill.replace('example-skill', name) })
  const root = await inspectSkillImport(skillZip([file('SKILL.md', 'root'), file('skills/child/SKILL.md', 'child')]), [])
  expect(root.candidates.map(row => row.name)).toEqual(['root'])
  const containers = await inspectSkillImport(
    skillZip([
      file('skills/a/b/c/SKILL.md', 'found'),
      file('skills/a/b/c/d/SKILL.md', 'too-deep'),
      file('elsewhere/SKILL.md', 'ignored'),
      { path: 'README.md', content: 'keep root' },
    ]),
    [],
  )
  expect(containers.candidates.map(row => row.name)).toEqual(['found'])
  const fallback = await inspectSkillImport(
    skillZip([
      file('a/b/c/d/e/SKILL.md', 'first'),
      file('z/SKILL.md', 'first'),
      file('node_modules/a/SKILL.md', 'ignored'),
      { path: 'README.md', content: 'keep root' },
    ]),
    [],
  )
  expect(fallback.candidates.map(row => [row.name, row.path])).toEqual([['first', 'a/b/c/d/e']])
  const groups = await inspectSkillImport(
    skillZip([
      file('skills/a/SKILL.md', 'one'),
      file('skills/b/SKILL.md', 'two'),
      { path: '.claude-plugin/plugin.json', content: JSON.stringify({ name: 'suggested', skills: ['./skills/a'] }) },
    ]),
    [],
  )
  expect(groups.packs).toEqual([{ name: 'suggested', description: 'suggested', skills: ['one'] }])
})
