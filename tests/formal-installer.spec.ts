import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { formalInstallerIdentity } from '../scripts/validation/formal-installer.mjs'

it('binds a formal installer to accepted build bytes when the tag adds only its publication receipts', () => {
  const root = mkdtempSync(join(tmpdir(), 'formal-installer-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  const installer = '#!/bin/bash\nexit 0\n'
  try {
    git('init', '-q')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(root, 'install.sh'), installer)
    git('add', '.')
    git('commit', '-qm', 'Accepted build')
    const commit = git('rev-parse', 'HEAD')
    mkdirSync(join(root, 'releases/acceptance'), { recursive: true })
    writeFileSync(join(root, 'releases/acceptance/0.1.26.json'), JSON.stringify({ status: 'accepted', commit }))
    git('add', '.')
    git('commit', '-qm', 'Publish acceptance')
    git('tag', 'v0.1.26')
    expect(formalInstallerIdentity(root, 'v0.1.26', { status: 'accepted', commit })).toEqual({
      tag: 'v0.1.26',
      tagCommit: git('rev-parse', 'HEAD'),
      builtSource: commit,
      installerSha256: createHash('sha256').update(installer).digest('hex'),
      changedPaths: ['releases/acceptance/0.1.26.json'],
    })
    writeFileSync(join(root, 'install.sh'), '#!/bin/bash\nexit 1\n')
    git('add', '.')
    git('commit', '-qm', 'Change executable')
    git('tag', 'v0.1.27')
    expect(() => formalInstallerIdentity(root, 'v0.1.27', { status: 'accepted', commit })).toThrow('deliverables changed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
