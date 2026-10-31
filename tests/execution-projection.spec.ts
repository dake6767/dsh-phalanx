import { mkdtemp, open, readFile, readlink, stat, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileExecutionProjection } from '../src/adapters/execution-projection.js'
import { FileCommunityMaintenance } from '../src/adapters/community-maintenance.js'

it('reuses an existing command generation in place while maintenance forbids reclaiming its tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-generation-maintenance-')),
    marker = join(root, 'maintenance'),
    maintenance = new FileCommunityMaintenance(marker)
  let commands = [{ owner: 'skill:example', skill: 'example', command: 'first-command' }]
  const projection = new FileExecutionProjection(
    join(root, 'members'),
    undefined,
    async () => commands,
    () => !maintenance.closed(),
  )
  try {
    await projection.prepare('member')
    const directory = join(root, 'members/member/commands'),
      generation = await readlink(join(directory, 'live')),
      before = await stat(join(directory, generation))
    commands = [{ ...commands[0]!, command: 'second-command' }]
    await projection.prepare('member')
    await writeFile(marker, 'closed')
    commands = [{ ...commands[0]!, command: 'first-command' }]
    await projection.prepare('member')
    expect((await stat(join(directory, generation))).ino).toBe(before.ino)
    expect(await readlink(join(directory, 'live'))).toBe(generation)
    expect(await readFile(join(directory, 'live/first-command'), 'utf8')).toContain('skill:example')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps an already-open forwarding program intact while atomically publishing changed commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-publication-'))
  let commands = [{ owner: 'skill:news', skill: 'news', command: 'news-cli' }]
  const projection = new FileExecutionProjection(root, undefined, async () => commands)
  try {
    await projection.prepare('member')
    const dispatch = join(root, 'member/commands/dispatch.mjs')
    const previous = '// Earlier installed release\n' + (await readFile(dispatch, 'utf8'))
    await chmod(dispatch, 0o700)
    await writeFile(dispatch, previous)
    const reading = await open(dispatch)
    try {
      commands = [...commands, { owner: 'skill:news', skill: 'news', command: 'second-cli' }]
      await projection.prepare('member')
      expect(await reading.readFile('utf8')).toBe(previous)
      expect(await readFile(dispatch, 'utf8')).not.toBe(previous)
      expect(await readFile(join(root, 'member/commands/live/second-cli'), 'utf8')).toContain('skill:news')
    } finally {
      await reading.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('adds a cloud script alias without replacing the member-local script', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-alias-'))
  const projection = new FileExecutionProjection(root, undefined, async () => [
    { owner: 'skill:audio', skill: 'audio', command: 'cloud-audio', source: 'scripts/audio.py', memberPath: 'scripts/cloud.py' },
  ])
  try {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'skills/audio/scripts'), { recursive: true })
    await writeFile(join(root, 'skills/audio/scripts/audio.py'), 'print("local audio")')
    await projection.prepare('member')
    await projection.apply('member', join(root, 'skills'))
    const alias = await readFile(join(root, 'skills/audio/scripts/cloud.py'), 'utf8')
    expect(alias).toContain('cloud-audio')
    expect(alias).toMatch(/^#!\/usr\/bin\/env python3/u)
    expect(await readFile(join(root, 'skills/audio/scripts/audio.py'), 'utf8')).toBe('print("local audio")')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('recreates alias directories after an update removes them from a read-only skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-alias-update-'))
  const skill = join(root, 'skills/audio')
  const projection = new FileExecutionProjection(root, undefined, async () => [
    { owner: 'skill:audio', skill: 'audio', command: 'cloud-audio', source: 'scripts/audio.py', memberPath: 'scripts/cloud.py' },
  ])
  const { mkdir } = await import('node:fs/promises')
  try {
    await mkdir(skill, { recursive: true })
    await chmod(skill, 0o555)
    await projection.apply('member', join(root, 'skills'))
    expect(await readFile(join(skill, 'scripts/cloud.py'), 'utf8')).toContain('cloud-audio')
  } finally {
    await chmod(skill, 0o700)
    await rm(root, { recursive: true, force: true })
  }
})
