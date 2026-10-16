import { createHash } from 'node:crypto'
import { readFile, readdir, lstat, readlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const hash = value => createHash('sha256').update(value).digest('hex')

export async function imageInputs(root = '.', { platform = 'linux/amd64', nodeImage } = {}) {
  if (!['linux/amd64', 'linux/arm64'].includes(platform)) throw Error('Unsupported image platform')
  const context = join(root, 'containers/dsh')
  const versions = JSON.parse(await readFile(join(root, 'runtime-versions.json'), 'utf8'))
  const recipe = await readFile(join(context, 'Containerfile'), 'utf8')
  const base = nodeImage || /^ARG NODE_IMAGE=(.+)$/mu.exec(recipe)?.[1]
  const baseImageDigest = /@(sha256:[a-f0-9]{64})$/u.exec(base ?? '')?.[1]
  if (!baseImageDigest || !versions.node || !versions.dsh?.repository ||
      !/^[a-f0-9]{40}$/u.test(versions.dsh?.revision) || !versions.dsh?.pnpm) throw Error('Image inputs require pinned base, DSH and runtime versions')
  const entries = []
  async function visit(directory = '') {
    for (const name of (await readdir(join(context, directory))).sort()) {
      const relative = directory ? `${directory}/${name}` : name
      const path = join(context, relative), facts = await lstat(path)
      if (facts.isSymbolicLink()) entries.push([relative, 'symlink', await readlink(path)])
      else if (facts.isDirectory()) { entries.push([relative, 'directory', facts.mode & 0o777]); await visit(relative) }
      else if (facts.isFile()) entries.push([relative, 'file', facts.mode & 0o777, hash(await readFile(path))])
      else throw Error(`Unsupported image context entry: ${relative}`)
    }
  }
  await visit()
  const inputs = { schema: 1, platform, context: entries, node: versions.node,
    dsh: { repository: versions.dsh.repository, revision: versions.dsh.revision, pnpm: versions.dsh.pnpm }, baseImageDigest }
  return { inputHash: hash(JSON.stringify(inputs)), dshRevision: versions.dsh.revision, baseImageDigest, platform }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), root = args[0] && !args[0].startsWith('--') ? args.shift() : '.'
  const options = {}
  while (args.length) {
    const flag = args.shift(), value = args.shift()
    if (!['--platform', '--node-image'].includes(flag) || !value) throw Error('Usage: image-inputs.mjs [SOURCE_ROOT] [--platform linux/amd64|linux/arm64] [--node-image DIGEST_PINNED_IMAGE]')
    options[flag === '--platform' ? 'platform' : 'nodeImage'] = value
  }
  console.log(JSON.stringify(await imageInputs(root, options)))
}
