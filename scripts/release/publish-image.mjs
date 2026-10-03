import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyDirectory, assetNames } from './integrity.mjs'
import { run } from './process.mjs'
import { registryDigest } from './registry.mjs'

const directory = process.argv[2]
const manifest = await verifyDirectory(directory, { tag: process.env.CANDIDATE_TAG, commit: process.env.CANDIDATE_SHA })
const tag = process.env.PROMOTION_VERSION ?? manifest.image.tag
if (!/^0\.1\.0(?:-rc\.[1-9]\d*)?$/u.test(tag)) throw new Error('Unexpected image tag')
const destination = `${manifest.image.name}:${tag}`
if (process.env.PROMOTION_VERSION && await registryDigest(manifest.image.name, manifest.image.tag, { anonymous: true }) !== manifest.image.digest) {
  throw new Error('Formal promotion requires the accepted image to be publicly readable first')
}
const authRoot = await mkdtemp(join(tmpdir(), 'dsh-phalanx-registry-'))
const authFile = join(authRoot, 'auth.json')
try {
  // Job token lives in a private temporary auth file, never an argument/build layer.
  await writeFile(authFile, JSON.stringify({ auths: { 'ghcr.io': {
    auth: Buffer.from(`${process.env.GITHUB_ACTOR}:${process.env.GH_TOKEN}`).toString('base64'),
  } } }), { mode: 0o600 })
  const existing = await registryDigest(manifest.image.name, tag)
  if (existing !== undefined) {
    const digest = existing
    if (digest !== manifest.image.digest) throw new Error('Immutable image tag conflict: use a new candidate')
  } else {
    run('skopeo', ['copy', '--preserve-digests', '--authfile', authFile,
      `oci-archive:${join(directory, assetNames[1])}`, `docker://${destination}`], { stdio: 'inherit' })
  }
  const digest = await registryDigest(manifest.image.name, tag)
  if (digest !== manifest.image.digest) throw new Error('Published registry digest mismatch')
  if (process.env.PROMOTION_VERSION && await registryDigest(manifest.image.name, tag, { anonymous: true }) !== digest) throw new Error('Formal image anonymous verification failed')
  console.log(`Verified ${destination}@${digest}`)
} finally { await rm(authRoot, { recursive: true, force: true }) }
