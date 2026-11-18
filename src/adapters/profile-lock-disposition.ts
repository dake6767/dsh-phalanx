import { spawnSync } from 'node:child_process'
import { closeSync, constants, existsSync, fstatSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertOwnedDirectory } from './user-storage-files.js'

const transaction = String.raw`
import ctypes, hashlib, json, os, stat, sys

name, staging, action, pid = sys.argv[1:]
profile, original = 3, 4
libc = ctypes.CDLL(None, use_errno=True)
exchange = libc.renameatx_np if sys.platform == 'darwin' else libc.renameat2

def swap():
    if exchange(profile, os.fsencode(name), stage, b'held', 2) != 0:
        raise OSError(ctypes.get_errno(), 'profile lock exchange failed')

def lookup(fd, file):
    try:
        return os.stat(file, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return None

def identity(info):
    return [info.st_dev, info.st_ino] if info else None

def fingerprint(info):
    return [*identity(info), info.st_mode, info.st_uid, info.st_size, info.st_nlink, info.st_mtime_ns]

def private(file, flags):
    return os.open(file, flags | os.O_NOFOLLOW, 0o600, dir_fd=stage)

def native_claim_name(record):
    return name + '.takeover-' + hashlib.sha256(os.fsencode(record + '\n')).hexdigest()[:16]

def link_visible(file, destination):
    try:
        os.link(file, destination, src_dir_fd=stage, dst_dir_fd=profile, follow_symlinks=False)
    except FileExistsError:
        if identity(lookup(profile, destination)) != identity(lookup(stage, file)):
            return False
    os.fsync(profile)
    os.unlink(file, dir_fd=stage)
    return True

def retire_visible(file, slot, expected):
    displaced = lookup(stage, slot)
    if displaced is None and identity(lookup(profile, file)) == expected:
        os.rename(file, slot, src_dir_fd=profile, dst_dir_fd=stage)
        displaced = lookup(stage, slot)
    if displaced is None:
        return True
    if identity(displaced) == expected:
        os.fsync(stage)
        os.fsync(profile)
        os.unlink(slot, dir_fd=stage)
        return True
    return link_visible(slot, file)

def dispose_proven(guard, expected, record):
    held = lookup(stage, 'held')
    if held is None or fingerprint(held) != expected:
        return False
    with os.fdopen(private('held', os.O_RDONLY), 'rb') as lock:
        if fingerprint(os.fstat(lock.fileno())) != expected or lock.read(12) != os.fsencode(record + '\n'):
            return False
    if not retire_visible(name, 'guard-retirement', guard):
        sys.exit(2)
    os.fsync(profile)
    os.unlink('held', dir_fd=stage)
    return True

def restore(guard):
    if lookup(stage, 'guard-retirement') and not retire_visible(name, 'guard-retirement', guard):
        return False
    visible = identity(lookup(profile, name))
    isolated = identity(lookup(stage, 'held'))
    if isolated == guard:
        return visible != guard
    if visible == guard and isolated is not None:
        # Restore the actual replacement while keeping the lock path occupied.
        # A racing third inode stays in the journal for diagnosis.
        swap()
        os.fsync(profile)
        os.fsync(stage)
        return identity(lookup(stage, 'held')) == guard
    # Resume a no-overwrite restore if the visible entry was already absent.
    if isolated is not None and (visible is None or visible == isolated):
        return link_visible('held', name)
    return isolated is None and visible != guard

if action == 'remove':
    os.mkdir(staging, 0o700)
stage = os.open(staging, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
info = os.fstat(stage)
if info.st_uid != os.getuid() or info.st_mode & 0o077:
    raise PermissionError('invalid profile recovery directory')

journal_facts = None
if action == 'restore':
    if lookup(stage, 'journal'):
        with os.fdopen(private('journal', os.O_RDONLY)) as journal:
            recovered = json.load(journal)
        journal_facts = recovered
        if recovered['profile'] != identity(os.fstat(profile)):
            sys.exit(2)
        guard = recovered['guard']
        if not dispose_proven(guard, recovered.get('expected'), recovered.get('pid')) and not restore(guard):
            sys.exit(2)
    elif lookup(stage, 'held') is not None:
        # An exchange cannot have run before the journal was written.
        if not stat.S_ISREG(lookup(stage, 'held').st_mode):
            sys.exit(2)
else:
    expected = fingerprint(os.fstat(original))
    if os.pread(original, 12, 0) != os.fsencode(pid + '\n'):
        sys.exit(2)
    with os.fdopen(private('held', os.O_WRONLY | os.O_CREAT | os.O_EXCL), 'w') as sentinel:
        # The pinned DSH takeover protocol requires a numeric record and newline.
        sentinel.write('profile lock recovery in progress\n')
        sentinel.flush()
        os.fsync(sentinel.fileno())
        guard = identity(os.fstat(sentinel.fileno()))
    with os.fdopen(private('claim', os.O_WRONLY | os.O_CREAT | os.O_EXCL), 'w') as claim:
        claim.write(str(os.getpid()) + '\n')
        claim.flush()
        os.fsync(claim.fileno())
    claim_name = native_claim_name(pid)
    journal_facts = {'guard': guard, 'profile': identity(os.fstat(profile)), 'expected': expected, 'pid': pid}
    with os.fdopen(private('journal.next', os.O_WRONLY | os.O_CREAT | os.O_EXCL), 'w') as journal:
        json.dump(journal_facts, journal)
        journal.flush()
        os.fsync(journal.fileno())
    os.rename('journal.next', 'journal', src_dir_fd=stage, dst_dir_fd=stage)
    os.fsync(stage)
    parent = os.open(os.path.dirname(staging), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    os.fsync(parent)
    os.close(parent)
    try:
        os.link('claim', claim_name, src_dir_fd=stage, dst_dir_fd=profile, follow_symlinks=False)
    except FileExistsError:
        result = 'active'
    else:
        os.fsync(profile)
        try:
            swap()
        except FileNotFoundError:
            pass
        else:
            if dispose_proven(guard, expected, pid):
                result = 'recovered'
            elif not restore(guard):
                sys.exit(2)

if journal_facts and isinstance(journal_facts.get('pid'), str):
    claim = identity(lookup(stage, 'claim'))
    claim_name = native_claim_name(journal_facts['pid'])
    if claim is not None and not retire_visible(claim_name, 'claim-retirement', claim):
        sys.exit(2)
for file in ['held', 'claim', 'journal.next', 'journal']:
    if lookup(stage, file):
        os.unlink(file, dir_fd=stage)
os.rmdir(staging)
print(locals().get('result', 'changed' if action == 'remove' else 'restored'))
`

export function profileLockDispositionPending(home: string): boolean {
  return existsSync(join(dirname(home), '.profile-lock-recovery'))
}

/** Keep a lock visible while isolating its actual inode. Never delete a displaced replacement. */
export function disposeProfileLock(profile: string, home: string, file: string, original?: { fd: number; pid: number; profile: string }): string {
  const parent = dirname(home),
    staging = join(parent, '.profile-lock-recovery')
  if (!original && !profileLockDispositionPending(home)) return 'restored'
  assertOwnedDirectory(parent)
  const directory = openSync(profile, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const { dev, ino } = fstatSync(directory, { bigint: true })
    if (original && original.profile !== `${dev}:${ino}`) return 'changed'
    const result = spawnSync('python3', ['-I', '-c', transaction, file, staging, original ? 'remove' : 'restore', String(original?.pid ?? 0)], {
      stdio: ['ignore', 'pipe', 'pipe', directory, original?.fd ?? 'ignore'],
      encoding: 'utf8',
      timeout: 5_000,
    })
    return result.status === 0 ? result.stdout.trim() : 'unknown'
  } finally {
    closeSync(directory)
  }
}
