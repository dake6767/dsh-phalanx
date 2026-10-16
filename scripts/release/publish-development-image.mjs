import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageInputs } from './image-inputs.mjs'
import { sha256 } from './integrity.mjs'
import { registryDigest } from './registry.mjs'
import { api, run } from './process.mjs'

const directory = process.argv[2], name = 'ghcr.io/dake6767/dsh-phalanx-dev'
if (process.argv.length !== 3) throw Error('Usage: publish-development-image.mjs TESTED_IMAGE_DIRECTORY')
const inputs = await imageInputs('.', { platform: 'linux/arm64' })
const archive = `oci-archive:${join(directory, 'dsh-phalanx-dsh-linux-arm64.oci.tar')}`
const config = JSON.parse(run('skopeo', ['inspect', '--config', archive]))
const valid = value => value.os === 'linux' && value.architecture === 'arm64' && value.config?.User === 'node' &&
  value.config.Labels?.['dsh.input.sha256'] === inputs.inputHash && value.config.Labels?.['dsh.revision'] === inputs.dshRevision &&
  value.config.Labels?.['dsh.development'] === 'unsupported' &&
  value.config.Labels?.['org.opencontainers.image.source'] === 'https://github.com/dake6767/dsh-phalanx' &&
  value.config.Labels?.['org.opencontainers.image.description'] === 'For development only; unsupported' &&
  /^[a-f0-9]{40}$/u.test(value.config.Labels?.['org.opencontainers.image.revision'])
if (!valid(config) || config.config.Labels['org.opencontainers.image.revision'] !== run('git', ['rev-parse', 'HEAD'])) {
  throw Error('Development image does not match the tested source, platform or independent inputs')
}
const archiveDigest = `sha256:${sha256(run('skopeo', ['inspect', '--raw', archive], { encoding: 'buffer' }))}`
const authRoot = await mkdtemp(join(tmpdir(), 'dsh-phalanx-development-registry-')), authFile = join(authRoot, 'auth.json')
try {
  await writeFile(authFile, JSON.stringify({ auths: { 'ghcr.io': {
    auth: Buffer.from(`${process.env.GITHUB_ACTOR}:${process.env.GH_TOKEN}`).toString('base64'),
  } } }), { mode: 0o600 })
  let digest = await registryDigest(name, inputs.inputHash)
  if (digest === undefined) {
    run('skopeo', ['copy', '--preserve-digests', '--authfile', authFile, archive, `docker://${name}:${inputs.inputHash}`], { stdio: 'inherit' })
    digest = await registryDigest(name, inputs.inputHash)
    if (digest !== archiveDigest) throw Error('Development image publication changed the tested digest')
  } else if (!valid(JSON.parse(run('skopeo', ['inspect', '--config', '--authfile', authFile, `docker://${name}@${digest}`])))) {
    throw Error('Existing development input tag has an incompatible image identity')
  }
  if (await registryDigest(name, inputs.inputHash, { anonymous: true }) !== digest) throw Error('Development package must allow anonymous digest pulls')
  const packagePath = 'users/dake6767/packages/container/dsh-phalanx-dev/versions'
  const versions = api(`${packagePath}?per_page=100`, ['--paginate', '--slurp']).flat()
    .filter(entry => entry.metadata?.container?.tags?.length === 1 && /^[a-f0-9]{64}$/u.test(entry.metadata.container.tags[0]))
  if (versions.some(entry => !Number.isSafeInteger(entry.id) || entry.id < 1 || !Number.isFinite(Date.parse(entry.created_at)))) {
    throw Error('Invalid development package version metadata')
  }
  versions.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)
  const removed = versions.slice(2).map(entry => ({ id: entry.id, digest: entry.name, inputHash: entry.metadata.container.tags[0] }))
  for (const entry of removed) run('gh', ['api', `${packagePath}/${entry.id}`, '--method', 'DELETE'], { stdio: 'inherit' })
  const receipt = { ...inputs, name, digest, reference: `${name}@${digest}`, unsupported: true,
    retained: versions.slice(0, 2).map(entry => entry.metadata.container.tags[0]), removed }
  await writeFile(join(directory, 'development-image.json'), JSON.stringify(receipt, null, 2)+'\n')
  console.log(JSON.stringify(receipt))
} finally { await rm(authRoot, { recursive: true, force: true }) }
