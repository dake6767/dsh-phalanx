import { parseSkillGitSource } from '../src/domain/skill-git-source.js'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import { writeFile, mkdir, stat, readdir, readFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { GitSkillRepository } from '../src/adapters/skill-git.js'
import { gitFixture } from './fixtures/skills/git-repository.js'
import { validSkill } from './fixtures/skills/archive.js'

it('clones a shallow anonymous HTTPS repository through the proxy without hooks, LFS or submodules', async () => {
  const fixture = await gitFixture()
  try {
    const commit = await fixture.commit({
      'skills/one/SKILL.md': validSkill,
      '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n',
      'skills/one/large.bin': 'version https://git-lfs.github.com/spec/v1\noid sha256:123\nsize 999999\n',
      '.gitmodules': '[submodule "vendor"]\n path = vendor\n url = https://must-not-fetch.example/repo\n',
    })
    fixture.git(['update-index', '--add', '--cacheinfo', `160000,${commit},vendor`])
    fixture.git(['commit', '-m', 'Submodule'])
    await mkdir(join(fixture.repo, '.git/hooks'), { recursive: true })
    await writeFile(join(fixture.repo, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch '${fixture.marker}'\n`, { mode: 0o755 })
    await writeFile(
      join(fixture.root, '.gitconfig'),
      `[core]\n hooksPath = ${fixture.repo}/.git/hooks\n[filter "lfs"]\n smudge = touch ${fixture.marker}\n required = true\n`,
    )
    vi.stubEnv('HOME', fixture.root)
    const adapter = new GitSkillRepository(join(fixture.root, 'imports'), fixture)
    const result = await adapter.read({ url: fixture.url, ref: 'main', subpath: '' }, new AbortController().signal)
    expect(result.commit).toBe(fixture.git(['rev-parse', 'HEAD']))
    expect(result.files.find(row => row.path === 'skills/one/SKILL.md')?.bytes.toString()).toBe(validSkill)
    expect(result.files.find(row => row.path.endsWith('large.bin'))?.bytes.toString()).toContain('git-lfs')
    expect(result.files.some(row => row.path.startsWith('vendor/'))).toBe(false)
    await expect(stat(fixture.marker)).rejects.toMatchObject({ code: 'ENOENT' })
    fixture.git(['branch', 'release/stable'])
    const branch = await adapter.read(
      { url: fixture.url, ref: 'release', subpath: 'stable/skills/one', tree: 'release/stable/skills/one' },
      new AbortController().signal,
    )
    expect(branch.target).toEqual({ url: fixture.url, ref: 'release/stable', subpath: 'skills/one' })
    const pinned = await adapter.read(
      { ...parseSkillGitSource(`https://github.com/owner/repo/tree/${commit}/skills/one`), url: fixture.url },
      new AbortController().signal,
    )
    expect(pinned.commit).toBe(commit)
    expect(fixture.connects()).toBeGreaterThan(0)
    expect(await readdir(join(fixture.root, 'imports'))).toEqual([])
    await expect(
      new GitSkillRepository(join(fixture.root, 'imports'), { ...fixture, maxBytes: 100 }).read(
        { url: fixture.url, ref: '', subpath: '' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'skill-upload-too-large' })
    const started = fixture.stall(),
      controller = new AbortController()
    const pending = adapter.read({ url: fixture.url, ref: '', subpath: '' }, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await started
    controller.abort()
    await rejected
    const timed = new GitSkillRepository(join(fixture.root, 'imports'), { ...fixture, timeoutMs: 100 })
    await expect(timed.read({ url: fixture.url, ref: '', subpath: '' }, new AbortController().signal)).rejects.toMatchObject({
      code: 'skill-archive-invalid',
      params: { reason: 'Git import exceeded the 120 second deadline.' },
    })
    expect(await readdir(join(fixture.root, 'imports'))).toEqual([])
  } finally {
    vi.unstubAllEnvs()
    await fixture.close()
  }
}, 20_000)

it('reclaims interrupted clones on restart only after their owned subprocesses exit', async () => {
  const fixture = await gitFixture(),
    root = join(fixture.root, 'imports')
  try {
    await fixture.commit({ 'SKILL.md': validSkill })
    const stage = join(root, 'git-old123')
    await mkdir(stage, { recursive: true })
    await writeFile(join(stage, 'process.pid'), String(process.pid))
    const recovered = new GitSkillRepository(root, fixture)
    await expect(recovered.recover()).rejects.toMatchObject({ code: 'skill-archive-invalid' })
    await writeFile(join(stage, 'process.pid'), '2147483647')
    await recovered.recover()
    expect(await readdir(root)).toEqual([])
    const started = fixture.stall()
    const code = `import { GitSkillRepository } from './src/adapters/skill-git.ts'; await new GitSkillRepository(${JSON.stringify(root)}, ${JSON.stringify({ proxy: fixture.proxy, caFile: fixture.caFile })}).read({url:${JSON.stringify(fixture.url)},ref:'',subpath:''},new AbortController().signal);`
    const parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: 'ignore' })
    try {
      await started
      const directory = (await readdir(root))[0]!,
        supervisor = Number(await readFile(join(root, directory, 'process.pid'), 'utf8'))
      const stopped = once(parent, 'close')
      parent.kill('SIGKILL')
      await stopped
      await vi.waitFor(() => {
        expect(() => process.kill(supervisor, 0)).toThrow()
      })
      await new GitSkillRepository(root, fixture).recover()
      expect(await readdir(root)).toEqual([])
    } finally {
      parent.kill('SIGKILL')
    }
  } finally {
    await fixture.close()
  }
}, 20_000)

it('imports ordinary skill files without following unrelated repository links and rejects links inside a skill', async () => {
  const fixture = await gitFixture()
  const artifacts = new FileSkillArtifacts(join(fixture.root, 'artifacts'), [], new GitSkillRepository(join(fixture.root, 'imports'), fixture))
  const source = { url: fixture.url, ref: 'main', subpath: '' },
    signal = new AbortController().signal
  try {
    await fixture.commit({ 'skills/one/SKILL.md': validSkill, 'README.md': 'Repository instructions' })
    await symlink('README.md', join(fixture.repo, 'AGENTS.md'))
    await symlink('/must-not-read-outside-repository', join(fixture.repo, 'unrelated-link'))
    await fixture.commit({})
    const imported = await artifacts.acceptGit(source, signal)
    expect(imported.candidates.map(row => row.name)).toEqual(['example-skill'])
    expect((await artifacts.read(imported.candidates[0]!.hash)).files).toEqual(['SKILL.md'])
    await symlink('../../README.md', join(fixture.repo, 'skills/one/reference.md'))
    await fixture.commit({})
    await expect(artifacts.acceptGit(source, signal)).rejects.toMatchObject({ code: 'skill-archive-invalid' })
    await rm(join(fixture.repo, 'skills/one/reference.md'))
    await symlink('skills/one/SKILL.md', join(fixture.repo, 'SKILL.md'))
    await fixture.commit({})
    await expect(artifacts.acceptGit(source, signal)).rejects.toMatchObject({ code: 'skill-archive-invalid' })
    await expect(artifacts.acceptGit({ ...source, subpath: 'skills/one' }, signal)).resolves.toMatchObject({ candidates: [{ name: 'example-skill' }] })
    await symlink('one/SKILL.md', join(fixture.repo, 'skills/SKILL.md'))
    await fixture.commit({})
    await expect(artifacts.acceptGit({ ...source, subpath: 'skills' }, signal)).rejects.toMatchObject({ code: 'skill-archive-invalid' })
  } finally {
    await artifacts.collect([])
    await fixture.close()
  }
}, 20_000)

it('imports a pinned commit without downloading a later unrelated oversized tree', async () => {
  const fixture = await gitFixture()
  try {
    const pinned = await fixture.commit({ 'skills/one/SKILL.md': validSkill })
    await fixture.commit({ 'unrelated-latest.bin': randomBytes(300_000).toString('base64') })
    const adapter = new GitSkillRepository(join(fixture.root, 'imports'), { ...fixture, maxBytes: 100_000 })
    const result = await adapter.read({ url: fixture.url, ref: pinned, subpath: 'skills/one' }, new AbortController().signal)
    expect(result.commit).toBe(pinned)
    expect(result.files.map(file => file.path)).toEqual(['skills/one/SKILL.md'])
    expect(result.files[0]!.bytes.toString()).toBe(validSkill)
    expect(await readdir(join(fixture.root, 'imports'))).toEqual([])
  } finally {
    await fixture.close()
  }
}, 20_000)

it('bounds Git objects and expanded files separately instead of counting the same content twice', async () => {
  const fixture = await gitFixture()
  try {
    const pinned = await fixture.commit({ 'SKILL.md': validSkill, 'asset.txt': randomBytes(52_000).toString('base64') })
    const adapter = new GitSkillRepository(join(fixture.root, 'imports'), { ...fixture, maxBytes: 100_000 })
    const result = await adapter.read({ url: fixture.url, ref: pinned, subpath: '' }, new AbortController().signal)
    expect(result.commit).toBe(pinned)
    expect(result.files.find(file => file.path === 'SKILL.md')?.bytes.toString()).toBe(validSkill)
    const oversized = await fixture.commit({ 'asset.txt': 'x'.repeat(120_000) })
    await expect(adapter.read({ url: fixture.url, ref: oversized, subpath: '' }, new AbortController().signal)).rejects.toMatchObject({
      code: 'skill-upload-too-large',
    })
    expect(await readdir(join(fixture.root, 'imports'))).toEqual([])
  } finally {
    await fixture.close()
  }
}, 20_000)

it('imports the selected subtree without downloading unrelated blobs and treats path globs literally', async () => {
  const fixture = await gitFixture()
  try {
    fixture.git(['config', 'uploadpack.allowFilter', 'true'])
    const pinned = await fixture.commit({ 'skills/literal[1]/SKILL.md': validSkill, 'skills/literal1/unrelated.txt': randomBytes(200_000).toString('base64') })
    const adapter = new GitSkillRepository(join(fixture.root, 'imports'), { ...fixture, maxBytes: 100_000 })
    const result = await adapter.read({ url: fixture.url, ref: pinned, subpath: 'skills/literal[1]' }, new AbortController().signal)
    expect(result.commit).toBe(pinned)
    expect(result.files.map(file => file.path)).toEqual(['skills/literal[1]/SKILL.md'])
    expect(result.files[0]!.bytes.toString()).toBe(validSkill)
    expect(await readdir(join(fixture.root, 'imports'))).toEqual([])
  } finally {
    await fixture.close()
  }
}, 20_000)
