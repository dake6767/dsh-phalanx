import { createHash } from 'node:crypto'
import type { SpawnSyncOptions } from 'node:child_process'
import { link, mkdtemp, mkdir, open, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { recoverMemberProfileWriteLock } from '../src/adapters/member-profile-write-lock.js'
import { disposeProfileLock } from '../src/adapters/profile-lock-disposition.js'
import { runIndependentProfileWriter, withProfileWriterAdmission } from '../src/adapters/profile-writer-admission.js'
import { dshWebProfilePath } from '../src/dsh/profile-layout.js'

const interception = vi.hoisted(() => ({ python: '' }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawnSync(command: string, args: string[] = [], options?: SpawnSyncOptions) {
      const flags = [...args]
      if (interception.python && command === 'python3' && flags[0] === '-I' && flags[1] === '-c') {
        flags[2] = flags[2]!.replace('profile, original = 3, 4', `profile, original = 3, 4\n${interception.python}`)
      }
      return actual.spawnSync(command, flags, options)
    },
  }
})

let root: string | undefined
afterEach(async () => {
  interception.python = ''
  if (root) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'member-write-lock-'))
  const home = join(root, 'home')
  const profile = dshWebProfilePath(home)
  await mkdir(profile, { recursive: true, mode: 0o700 })
  const manifest = join(profile, 'package.json')
  const lock = manifest + '.lock'
  await writeFile(manifest, '{"committed":true}', { mode: 0o600 })
  await writeFile(lock, '34\n', { mode: 0o600 })
  const lockTime = (await stat(lock)).birthtimeMs
  const terminated = { state: 'exited' as const, startedAt: lockTime - 1000, finishedAt: lockTime + 1000 }
  return { home, manifest, lock, terminated }
}

it('removes only the confirmed exited generation’s lock and preserves the committed manifest', async () => {
  const f = await fixture()
  expect(await recoverMemberProfileWriteLock(f.home, async () => f.terminated)).toBe('recovered')
  await expect(readFile(f.lock)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(f.manifest, 'utf8')).toBe('{"committed":true}')
})

it.each(['unknown', 'active'] as const)('preserves a lock when carrier or writer evidence is %s', async state => {
  const f = await fixture()
  expect(await recoverMemberProfileWriteLock(f.home, async () => ({ state }))).toBe(state)
  expect(await readFile(f.lock, 'utf8')).toBe('34\n')
})

it('preserves a replacement with the same PID record and keeps the committed manifest', async () => {
  const f = await fixture()
  expect(
    await recoverMemberProfileWriteLock(f.home, async () => {
      await rename(f.lock, f.lock + '.prior')
      await writeFile(f.lock, '34\n', { mode: 0o600 })
      return f.terminated
    }),
  ).toBe('changed')
  expect(await readFile(f.lock, 'utf8')).toBe('34\n')
  expect(await readFile(f.manifest, 'utf8')).toBe('{"committed":true}')
})

it('leaves a native DSH takeover claim and its original lock to the existing contender', async () => {
  const f = await fixture()
  const claim = f.lock + '.takeover-' + createHash('sha256').update('34\n').digest('hex').slice(0, 16)
  await writeFile(claim, '19\n', { mode: 0o600 })
  expect(await recoverMemberProfileWriteLock(f.home, async () => f.terminated)).toBe('active')
  expect(await readFile(f.lock, 'utf8')).toBe('34\n')
  expect(await readFile(claim, 'utf8')).toBe('19\n')
})

it('records independently admitted writers before they can mount the profile', async () => {
  const f = await fixture()
  const initial = await withProfileWriterAdmission(f.home, async state => state)
  let entered!: () => void, release!: () => void
  const enteredWriter = new Promise<void>(resolve => {
    entered = resolve
  })
  const releaseWriter = new Promise<void>(resolve => {
    release = resolve
  })
  let writer: Promise<void> | undefined
  await withProfileWriterAdmission(f.home, async state => {
    expect(state).toEqual(initial)
    writer = runIndependentProfileWriter(f.home, async () => {
      entered()
      await releaseWriter
    })
    await Promise.resolve()
    expect(await readFile(join(dirname(f.home), '.profile-writer-revision'), 'utf8')).toBe(initial.revision)
  })
  await enteredWriter
  try {
    const running = await withProfileWriterAdmission(f.home, async state => state)
    expect(running.active).toBe(true)
    expect(running.revision).not.toBe(initial.revision)
  } finally {
    release()
    await writer
  }
  const finished = await withProfileWriterAdmission(f.home, async state => state)
  expect(finished.active).toBe(false)
  expect(finished.revision).not.toBe(initial.revision)
})

it('restores a last-moment replacement when atomic isolation captures a different inode', async () => {
  const f = await fixture()
  const profile = dirname(f.lock)
  const { dev, ino } = await stat(profile, { bigint: true })
  const prior = await open(f.lock, 'r')
  try {
    await rename(f.lock, f.lock + '.prior')
    await writeFile(f.lock, '34\n', { mode: 0o600 })
    const replacement = await stat(f.lock, { bigint: true })
    // Schedule an O_EXCL contender exactly after a pathname rename that could expose a gap.
    interception.python = String.raw`
original_rename = os.rename
def contend_on_rename(src, dst, **options):
    original_rename(src, dst, **options)
    if src == name and options.get('src_dir_fd') == profile:
        try:
            contender = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=profile)
        except FileExistsError:
            return
        with os.fdopen(contender, 'w') as writer:
            writer.write('93\n')
os.rename = contend_on_rename
`
    expect(disposeProfileLock(profile, f.home, 'package.json.lock', { fd: prior.fd, pid: 34, profile: `${dev}:${ino}` })).toBe('changed')
    expect((await stat(f.lock, { bigint: true })).ino).toBe(replacement.ino)
    expect(await readFile(f.lock, 'utf8')).toBe('34\n')
  } finally {
    await prior.close()
  }
})

it('preserves a competing native claim installed after the cleanup identity check', async () => {
  const f = await fixture()
  const claim = f.lock + '.takeover-' + createHash('sha256').update('34\n').digest('hex').slice(0, 16)
  interception.python = String.raw`
original_stat = os.stat
replaced_claim = False
def replace_claim_after_lookup(file, **options):
    global replaced_claim
    info = original_stat(file, **options)
    if not replaced_claim and isinstance(file, str) and file.startswith(name + '.takeover-') and options.get('dir_fd') == profile:
        replaced_claim = True
        os.rename(file, file + '.before', src_dir_fd=profile, dst_dir_fd=profile)
        with os.fdopen(os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=profile), 'w') as replacement:
            replacement.write('93\n')
    return info
os.stat = replace_claim_after_lookup
`
  expect(await recoverMemberProfileWriteLock(f.home, async () => f.terminated)).toBe('recovered')
  expect(await readFile(claim, 'utf8')).toBe('93\n')
  await expect(readFile(f.lock)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('restores the displaced lock after interruption without replacing a different visible file', async () => {
  const f = await fixture()
  const profile = dirname(f.lock)
  const staging = join(dirname(f.home), '.profile-lock-recovery')
  await mkdir(staging, { mode: 0o700 })
  const held = join(staging, 'held')
  await rename(f.lock, held)
  const displaced = await stat(held)
  await writeFile(f.lock, '34\n', { mode: 0o600 })
  const sentinel = await stat(f.lock)
  const directory = await stat(profile)
  await writeFile(join(staging, 'journal'), JSON.stringify({ guard: [sentinel.dev, sentinel.ino], profile: [directory.dev, directory.ino] }), {
    mode: 0o600,
  })
  await rename(f.lock, f.lock + '.sentinel')
  await writeFile(f.lock, '97\n', { mode: 0o600 })
  expect(disposeProfileLock(profile, f.home, 'package.json.lock')).toBe('unknown')
  expect(await readFile(f.lock, 'utf8')).toBe('97\n')
  expect((await stat(held)).ino).toBe(displaced.ino)
  await rename(f.lock + '.sentinel', f.lock)
  expect(disposeProfileLock(profile, f.home, 'package.json.lock')).toBe('restored')
  expect((await stat(f.lock)).ino).toBe(displaced.ino)
})

it('completes an interrupted disposal using the proven displaced inode and record', async () => {
  const f = await fixture()
  const profile = dirname(f.lock),
    staging = join(dirname(f.home), '.profile-lock-recovery'),
    held = join(staging, 'held')
  await mkdir(staging, { mode: 0o700 })
  await rename(f.lock, held)
  const displaced = await stat(held, { bigint: true })
  await writeFile(f.lock, '34\n', { mode: 0o600 })
  const sentinel = await stat(f.lock, { bigint: true })
  const directory = await stat(profile, { bigint: true })
  const takeover = f.lock + '.takeover-' + createHash('sha256').update('34\n').digest('hex').slice(0, 16)
  await writeFile(join(staging, 'claim'), '19\n', { mode: 0o600 })
  await link(join(staging, 'claim'), takeover)
  // Serialize the integer fields without rounding Linux inode times in JavaScript.
  await writeFile(
    join(staging, 'journal'),
    `{"guard":[${sentinel.dev},${sentinel.ino}],"profile":[${directory.dev},${directory.ino}],"expected":[${displaced.dev},${displaced.ino},${displaced.mode},${displaced.uid},${displaced.size},${displaced.nlink},${displaced.mtimeNs}],"pid":"34"}`,
    { mode: 0o600 },
  )
  expect(disposeProfileLock(profile, f.home, 'package.json.lock')).toBe('restored')
  await expect(readFile(f.lock)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(takeover)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(staging)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(f.manifest, 'utf8')).toBe('{"committed":true}')
})

it('finishes restoration interrupted after the displaced lock was linked back', async () => {
  const f = await fixture()
  const profile = dirname(f.lock),
    staging = join(dirname(f.home), '.profile-lock-recovery'),
    held = join(staging, 'held')
  const directory = await stat(profile)
  await mkdir(staging, { mode: 0o700 })
  await link(f.lock, held)
  await writeFile(join(staging, 'journal'), JSON.stringify({ guard: [0, 0], profile: [directory.dev, directory.ino] }), { mode: 0o600 })
  expect(disposeProfileLock(profile, f.home, 'package.json.lock')).toBe('restored')
  expect(await readFile(f.lock, 'utf8')).toBe('34\n')
  expect((await stat(f.lock)).nlink).toBe(1)
  await expect(stat(staging)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not follow a member home replaced by a symlink to another profile', async () => {
  const f = await fixture()
  const other = join(f.home, 'other-home')
  await mkdir(other, { mode: 0o700 })
  const manifest = dshWebProfilePath(other)
  await mkdir(manifest, { recursive: true, mode: 0o700 })
  const otherLock = join(manifest, 'package.json.lock')
  await writeFile(otherLock, '34\n', { mode: 0o600 })
  const replaced = join(f.home, 'former-home')
  await symlink(other, replaced, 'dir')
  expect(await recoverMemberProfileWriteLock(replaced, async () => f.terminated)).toBe('unknown')
  expect(await readFile(otherLock, 'utf8')).toBe('34\n')
})
