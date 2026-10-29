import { expect, it } from 'vitest'
import { parseSkillGitSource } from '../src/domain/skill-git-source.js'

it('accepts public HTTPS sources and canonicalizes GitHub paths and revisions', () => {
  expect(parseSkillGitSource('owner/repo/skills/one#v1')).toEqual({ url: 'https://github.com/owner/repo.git', subpath: 'skills/one', ref: 'v1' })
  expect(parseSkillGitSource('https://github.com/owner/repo/tree/main/skills/one')).toEqual({
    url: 'https://github.com/owner/repo.git',
    subpath: 'skills/one',
    ref: 'main',
    tree: 'main/skills/one',
  })
  expect(parseSkillGitSource('https://code.example/team/project.git#release/stable')).toEqual({
    url: 'https://code.example/team/project.git',
    subpath: '',
    ref: 'release/stable',
  })
  expect(parseSkillGitSource('https://github.com/owner/repo/tree/release%2Fstable/skills/one')).toEqual({
    url: 'https://github.com/owner/repo.git',
    subpath: 'skills/one',
    ref: 'release/stable',
  })
  expect(parseSkillGitSource('owner/repo')).toEqual({ url: 'https://github.com/owner/repo.git', subpath: '', ref: '' })
  for (const value of [
    'git@github.com:owner/repo',
    '/tmp/repo',
    'file:///tmp/repo',
    'http://code.example/repo',
    'https://user:password@code.example/repo',
    'https://code.example/.well-known/skills',
    'https://skillhub.tencent.com/api/skills',
    'owner/repo/../secret',
    'owner/repo#--upload-pack=evil',
    'https://localhost/repo',
    'https://127.0.0.1/repo',
  ]) {
    expect(() => parseSkillGitSource(value), value).toThrow()
  }
})
