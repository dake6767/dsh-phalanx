import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileMemberSkillNames, memberSkillNamesReader } from '../src/adapters/member-skill-names.js'

it('observes only names in both default roots without following an escape or creating absent roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-names-'))
  try {
    const reader = new FileMemberSkillNames({ dataRoot: root }, { getSpace: () => ({ spaceId: 'member', storageKey: 'member' }) })
    expect(await reader.names('member')).toEqual([])
    const home = join(root, 'users/member/home')
    await mkdir(join(home, '.dsh/skills/first'), { recursive: true })
    await mkdir(join(home, '.agents/skills/second'), { recursive: true })
    await writeFile(join(home, '.dsh/skills/ignored-file'), '')
    expect([...await reader.names('member')].sort()).toEqual(['first', 'second'])
    await rm(join(home, '.agents/skills'), { recursive: true })
    const outside = join(root, 'outside'); await mkdir(join(outside, 'hidden'), { recursive: true })
    await symlink(outside, join(home, '.agents/skills'))
    expect(await reader.names('member')).toEqual(['first'])
    const race = `import os, sys
original = os.scandir
changed = False
def replace_before_scan(fd):
    global changed
    if not changed:
        changed = True
        root = sys.argv[1] + '/.dsh/skills'
        os.rename(root, root + '-original')
        os.symlink(sys.argv[3], root)
    return original(fd)
os.scandir = replace_before_scan
`
    const observed = execFileSync('python3', ['-I', '-c', race + memberSkillNamesReader, home, JSON.stringify([['.dsh', 'skills']]), outside], { encoding: 'utf8' })
    expect(JSON.parse(observed)).toEqual(['first'])
    expect(await reader.names('member')).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})
