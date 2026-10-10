import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve, relative } from 'node:path'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { CommunityUserSpaceReaderPort } from '../ports/community-user-spaces.js'
import type { MemberSkillNamesPort } from '../ports/member-skills.js'
import { memberDefaultSkillRoots } from '../dsh/member-skills.js'

const execute = promisify(execFile)
/** Python is also the installed updater runtime; directory fds work on Linux and macOS. */
export const memberSkillNamesReader = `
import errno, json, os, sys
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
names = set()
absent = (errno.ENOENT, errno.ENOTDIR, errno.ELOOP)
try:
    home = os.open(sys.argv[1], flags)
except OSError as error:
    if error.errno not in absent: raise
    print('[]'); sys.exit(0)
try:
    for segments in json.loads(sys.argv[2]):
        handles = []
        try:
            current = home
            for segment in segments:
                current = os.open(segment, flags, dir_fd=current)
                handles.append(current)
            with os.scandir(current) as entries:
                for entry in entries:
                    if entry.is_dir(follow_symlinks=False) or entry.is_symlink(): names.add(entry.name)
        except OSError as error:
            if error.errno not in absent: raise
        finally:
            for handle in reversed(handles): os.close(handle)
finally:
    os.close(home)
print(json.dumps(sorted(names)))
`

/** Observe directory names only, without following or modifying member-controlled paths. */
export class FileMemberSkillNames implements MemberSkillNamesPort {
  constructor(private readonly config: Pick<CommunityRuntimeConfig, 'dataRoot' | 'userDataRoot'>, private readonly spaces: CommunityUserSpaceReaderPort) {}
  async names(username: string): Promise<readonly string[]> {
    const space = this.spaces.getSpace(username)
    if (!space) return []
    if (!/^(?:[a-z0-9][a-z0-9_-]{0,63}|_spaces\/[a-f0-9]{32})$/u.test(space.storageKey)) throw new Error('Invalid user space directory mapping')
    const home = resolve(this.config.userDataRoot ?? join(this.config.dataRoot, 'users'), space.storageKey, 'home')
    const roots = memberDefaultSkillRoots(home).map(root => relative(home, root).split('/'))
    const { stdout } = await execute('python3', ['-I', '-c', memberSkillNamesReader, home, JSON.stringify(roots)], { timeout: 10000, maxBuffer: 1024 * 1024 })
    return JSON.parse(stdout) as string[]
  }
}
