import { copyUserStorage } from '../src/adapters/user-storage-copy.js'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, lstat, utimes, chmod, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { FileCommunityEnvironment } from '../src/adapters/community-environment.js'

let root: string | undefined
const space = 'a'.repeat(32)
afterEach(async () => {
  vi.restoreAllMocks()
  if (root) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'environment-retention-'))
  const userRoot = join(root, 'users'),
    home = join(userRoot, 'alice', 'home'),
    workspace = join(userRoot, 'alice', 'workspace')
  await mkdir(join(home, '.dsh/profiles/web'), { recursive: true })
  await mkdir(workspace)
  await writeFile(join(home, '.dsh/profiles/web/cordis.patch.yml'), 'PRIVATE_CONFIGURATION')
  let now = 0
  const environment = new FileCommunityEnvironment(
    userRoot,
    { assertAvailable: async () => {}, prepare: async () => ({ home, workspace, spaceId: space }) },
    { now: () => ++now },
  )
  return {
    environment,
    userRoot,
    home,
    parent: join(userRoot, '_environment-backups', space),
    time: (value: number) => {
      now = value
    },
  }
}
it('keeps the newest three complete backups after publishing each new manifest', async () => {
  const f = await fixture(),
    backups = []
  for (let i = 0; i < 5; i++) backups.push(await f.environment.backup('alice', space))
  expect((await readdir(f.parent)).sort()).toEqual(
    backups
      .slice(-3)
      .map(row => row.id)
      .sort(),
  )
  for (const backup of backups.slice(-3)) {
    expect(await readFile(join(backup.location, 'files/.dsh/profiles/web/cordis.patch.yml'), 'utf8')).toBe('PRIVATE_CONFIGURATION')
    expect(JSON.parse(await readFile(join(backup.location, 'manifest.json'), 'utf8')).completedAt).toBeGreaterThan(0)
  }
  expect(await readFile(join(f.home, '.dsh/profiles/web/cordis.patch.yml'), 'utf8')).toBe('PRIVATE_CONFIGURATION')
})

it('orders old complete manifests by their write time, validates explicit times and always keeps the newly completed copy', async () => {
  const f = await fixture(),
    older = []
  for (let i = 0; i < 3; i++) older.push(await f.environment.backup('alice', space))
  for (const [index, backup] of older.entries()) {
    const path = join(backup.location, 'manifest.json'),
      manifest = JSON.parse(await readFile(path, 'utf8'))
    if (index === 0) delete manifest.completedAt
    else manifest.completedAt = index === 1 ? 900 : 800
    await writeFile(path, JSON.stringify(manifest))
    if (index === 0) await utimes(path, new Date(1000), new Date(1000))
  }
  f.time(0)
  const current = await f.environment.backup('alice', space)
  expect((await readdir(f.parent)).sort()).toEqual([older[0]!.id, older[1]!.id, current.id].sort())
})

it('ignores linked, foreign, incomplete or malformed directories and never follows configuration links', async () => {
  const f = await fixture(),
    older = []
  for (let i = 0; i < 3; i++) older.push(await f.environment.backup('alice', space))
  const outside = join(root!, 'outside')
  await mkdir(outside, { mode: 0o700 })
  await writeFile(join(outside, 'keep'), 'OUTSIDE')
  const unknown = ['1', '2', '3', '4', '5'].map(value => value.repeat(32))
  await mkdir(join(f.parent, unknown[0]!), { mode: 0o700 })
  await symlink(outside, join(f.parent, unknown[1]!))
  for (const id of unknown.slice(2)) await cp(older[0]!.location, join(f.parent, id), { recursive: true })
  const linked = join(f.parent, unknown[2]!, 'manifest.json')
  await rm(linked)
  await symlink(join(older[0]!.location, 'manifest.json'), linked)
  const foreign = join(f.parent, unknown[3]!, 'manifest.json'),
    foreignManifest = JSON.parse(await readFile(foreign, 'utf8'))
  foreignManifest.spaceId = 'b'.repeat(32)
  await writeFile(foreign, JSON.stringify(foreignManifest))
  const corrupt = join(f.parent, unknown[4]!, 'manifest.json'),
    corruptManifest = JSON.parse(await readFile(corrupt, 'utf8'))
  corruptManifest.completedAt = null
  await writeFile(corrupt, JSON.stringify(corruptManifest))
  await mkdir(join(root!, 'users', '_environment-backups', 'b'.repeat(32)), { mode: 0o700 })
  await writeFile(join(root!, 'users', '_environment-backups', 'b'.repeat(32), 'keep'), 'OTHER_SPACE')
  const patch = join(f.home, '.dsh/profiles/web/cordis.patch.yml')
  await rm(patch)
  await symlink(join(outside, 'keep'), patch)
  const current = await f.environment.backup('alice', space)
  const retained = await readdir(f.parent)
  for (const id of [...unknown, older[1]!.id, older[2]!.id, current.id]) expect(retained).toContain(id)
  expect(retained).not.toContain(older[0]!.id)
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('OUTSIDE')
  expect(await readFile(join(root!, 'users', '_environment-backups', 'b'.repeat(32), 'keep'), 'utf8')).toBe('OTHER_SPACE')
  expect((await lstat(join(current.location, 'files/.dsh/profiles/web/cordis.patch.yml'))).isSymbolicLink()).toBe(true)
})

it('logs an older-copy deletion failure without losing the new backup or blocking reset', async () => {
  const f = await fixture(),
    older = []
  for (let i = 0; i < 3; i++) older.push(await f.environment.backup('alice', space))
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await chmod(older[0]!.location, 0o500)
  try {
    const current = await f.environment.backup('alice', space)
    expect(warning).toHaveBeenCalledWith('Environment backup cleanup failed')
    expect(JSON.parse(await readFile(join(current.location, 'manifest.json'), 'utf8')).spaceId).toBe(space)
    await f.environment.reset('alice', space, current)
    await expect(lstat(join(f.home, '.dsh/profiles/web'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(current.location, 'files/.dsh/profiles/web/cordis.patch.yml'), 'utf8')).toBe('PRIVATE_CONFIGURATION')
  } finally {
    await chmod(older[0]!.location, 0o700)
  }
})

it('retains the latest three after copying the user volume and resolves restoration against its current home', async () => {
  const f = await fixture(),
    older = []
  for (let i = 0; i < 3; i++) older.push(await f.environment.backup('alice', space))
  const movedRoot = join(root!, 'moved-users')
  copyUserStorage(f.userRoot, movedRoot)
  const home = join(movedRoot, 'alice', 'home'),
    workspace = join(movedRoot, 'alice', 'workspace')
  const moved = new FileCommunityEnvironment(
    movedRoot,
    { assertAvailable: async () => {}, prepare: async () => ({ home, workspace, spaceId: space }) },
    { now: () => 100 },
  )
  const current = await moved.backup('alice', space)
  const parent = join(movedRoot, '_environment-backups', space)
  expect((await readdir(parent)).sort()).toEqual([older[1]!.id, older[2]!.id, current.id].sort())
  const retained = join(parent, older[1]!.id)
  expect(JSON.parse(await readFile(join(retained, 'manifest.json'), 'utf8'))).toMatchObject({ version: 2, home: 'alice/home' })
  expect(await readFile(join(retained, 'README.txt'), 'utf8')).toContain('<userDataRoot>/alice/home')
  await moved.reset('alice', space, { ...older[1]!, location: retained })
  await expect(lstat(join(home, '.dsh/profiles/web'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(f.home, '.dsh/profiles/web/cordis.patch.yml'), 'utf8')).toBe('PRIVATE_CONFIGURATION')
})
