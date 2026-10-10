import { expect, it } from 'vitest'
import { inspectSkillArchive } from '../src/adapters/skill-archive.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'

it('accepts a skill at the root or one wrapper directory and preserves opaque metadata and scripts', async () => {
  for (const prefix of ['', 'download/']) {
    const archive = await inspectSkillArchive(skillZip([
      { path: prefix + 'SKILL.md', content: validSkill },
      { path: prefix + '_meta.json', content: 'not parsed as JSON' },
      { path: prefix + 'scripts/example.py', content: 'print("fixture")' },
    ]), [])
    expect(archive).toMatchObject({ name: 'example-skill', description: 'A useful skill', markdown: validSkill })
    expect(archive.files.map(file => file.path)).toEqual(['SKILL.md', '_meta.json', 'scripts/example.py'])
    expect(archive.files.find(file => file.path === '_meta.json')?.bytes.toString()).toBe('not parsed as JSON')
  }
})

it('rejects ambiguous skill roots, traversal, links, special files and oversized contents', async () => {
  for (const files of [
    [{ path: 'readme.md', content: 'No skill' }],
    [{ path: 'SKILL.md', content: validSkill }, { path: 'nested/SKILL.md', content: validSkill }],
    [{ path: 'a/SKILL.md', content: validSkill }, { path: 'other.txt', content: 'outside root' }],
    [{ path: 'SKILL.md', content: validSkill }, { path: '../escape', content: 'outside' }],
    [{ path: 'SKILL.md', content: validSkill }, { path: 'scripts/link', content: '/etc/passwd', mode: 0o120777 }],
    [{ path: 'SKILL.md', content: validSkill }, { path: 'pipe', content: '', mode: 0o010644 }],
    [{ path: 'SKILL.md', content: validSkill }, { path: 'SKILL.md', content: validSkill }],
    [{ path: 'SKILL.md', content: validSkill }, { path: 'large.bin', content: Buffer.alloc(20 * 1024 * 1024) }],
  ]) await expect(inspectSkillArchive(skillZip(files), [])).rejects.toBeInstanceOf(Error)
  await expect(inspectSkillArchive(Buffer.alloc(20 * 1024 * 1024 + 1), [])).rejects.toMatchObject({ code: 'skill-upload-too-large' })
})

it('matches the fixed runtime frontmatter policy and rejects bundled names', async () => {
  for (const markdown of [
    validSkill.replace('name: example-skill', 'name: 中文'), validSkill.replace('description: A useful skill\n', ''),
    validSkill.replace('description: A useful skill', 'description: []'),
    ...['disableModelInvocation: true', 'modelInvocable: false', 'userInvocable: true', 'user-invocable: maybe', 'disable-model-invocation: []'].map(field => validSkill.replace('description: A useful skill', 'description: A useful skill\n' + field)),
  ]) await expect(inspectSkillArchive(skillZip([{ path: 'SKILL.md', content: markdown }]), [])).rejects.toMatchObject({ code: 'skill-frontmatter-invalid' })
  await expect(inspectSkillArchive(skillZip([{ path: 'SKILL.md', content: validSkill }]), ['example-skill'])).rejects.toMatchObject({ code: 'skill-builtin-conflict' })
  for (const value of ['true', 'false', 'yes', 'no', 'on', 'off', '1', '0', '"YES"']) {
    await expect(inspectSkillArchive(skillZip([{ path: 'SKILL.md', content: validSkill.replace('description: A useful skill', 'description: A useful skill\nuser-invocable: ' + value) }]), [])).resolves.toMatchObject({ name: 'example-skill' })
  }
})

it('reserves shipped runtime skills without reserving runtime test fixtures and localizes precise rejection reasons', async () => {
  const { runtimeSkillNames } = await import('../src/adapters/runtime-skills.js')
  const { platformError } = await import('../src/domain/platform-copy.js')
  await expect(inspectSkillArchive(skillZip([{ path: 'SKILL.md', content: validSkill.replace('example-skill', 'preview-tour') }]), runtimeSkillNames())).resolves.toMatchObject({ name: 'preview-tour' })
  await expect(inspectSkillArchive(skillZip([{ path: 'SKILL.md', content: validSkill.replace('example-skill', 'office-docx') }]), runtimeSkillNames())).rejects.toMatchObject({ code: 'skill-builtin-conflict' })
  try { await inspectSkillArchive(skillZip([{ path: 'SKILL.md', content: validSkill.replace('description: A useful skill', 'description: []') }]), []) }
  catch (error) {
    const failure = error as { code: string, message: string, params: { reason: string } }
    expect(platformError('zh-CN', { ...failure, error: failure.message })).toBe('description 字段须为非空字符串。')
  }
})
