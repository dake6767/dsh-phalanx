import { mkdir, readFile, rm, writeFile, chmod, cp, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { sha256, assetNames } from './integrity.mjs'
import { run } from './process.mjs'

if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build on Linux amd64; never package host dependencies from another platform')
const output = resolve(process.argv[2])
const stage = join(output, 'platform')
const versions = JSON.parse(await readFile('runtime-versions.json', 'utf8'))
const commit = run('git', ['rev-parse', 'HEAD'])
await mkdir(output, { recursive: true })
await rm(stage, { recursive: true, force: true })
run('corepack', ['pnpm', '--filter', 'dsh-phalanx', 'deploy', '--legacy', '--prod', stage], { stdio: 'inherit' })
// pnpm deploy excludes nested workspace packages, including the separately built UI.
await cp(resolve('admin-ui/dist'), join(stage, 'admin-ui/dist'), { recursive: true })
await Promise.all(['dist/composition/cli.js', 'admin-ui/dist/community.html'].map(name => access(join(stage, name))))
const nodeArchive = join(output, 'node.tar.xz')
run('curl', ['--fail', '--location', '--retry', '3', '--output', nodeArchive, versions.nodeLinuxAmd64.url])
if (sha256(await readFile(nodeArchive)) !== versions.nodeLinuxAmd64.sha256) throw new Error('Pinned Node archive checksum mismatch')
await mkdir(join(stage, 'node'))
run('tar', ['-xJf', nodeArchive, '--strip-components=1', '-C', join(stage, 'node')])
await rm(nodeArchive)
await writeFile(join(stage, 'build-info.json'), JSON.stringify({ commit, platform: 'linux/amd64', versions }, null, 2) + '\n')
await writeFile(join(stage, 'start'), '#!/bin/sh\nset -eu\ncd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec ./node/bin/node dist/composition/cli.js "$@"\n')
await chmod(join(stage, 'start'), 0o755)
const epoch = run('git', ['show', '-s', '--format=%ct', 'HEAD'])
run('tar', ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner', '-czf', join(output, assetNames[0]), '-C', stage, '.'])
await rm(stage, { recursive: true })
