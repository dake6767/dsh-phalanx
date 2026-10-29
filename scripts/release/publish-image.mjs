import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyDirectory, assetNames } from './integrity.mjs'
import { run } from './process.mjs'
import { registryDigest } from './registry.mjs'

const directory = process.argv[2]
const manifest = await verifyDirectory(directory, { tag: process.env.CANDIDATE_TAG, commit: process.env.CANDIDATE_SHA })
const tag = process.env.PROMOTION_VERSION ?? manifest.image.tag
if (tag !== (process.env.PROMOTION_VERSION ? manifest.targetVersion : manifest.image.tag)) throw new Error('Unexpected image tag')
if (process.env.PROMOTION_VERSION && manifest.imageSelection?.rehearsal) throw Error('Image reuse rehearsal candidates cannot be promoted')
const destination = `${manifest.image.name}:${tag}`
if (process.env.PROMOTION_VERSION && (await registryDigest(manifest.image.name, manifest.image.tag, { anonymous: true })) !== manifest.image.digest) {
  throw new Error('Formal promotion requires the accepted image to be publicly readable first')
}
const authRoot = await mkdtemp(join(tmpdir(), 'dsh-phalanx-registry-'))
const authFile = join(authRoot, 'auth.json')
try {
  // Job token lives in a private temporary auth file, never an argument/build layer.
  await writeFile(
    authFile,
    JSON.stringify({
      auths: {
        'ghcr.io': {
          auth: Buffer.from(`${process.env.GITHUB_ACTOR}:${process.env.GH_TOKEN}`).toString('base64'),
        },
      },
    }),
    { mode: 0o600 },
  )
  const existing = await registryDigest(manifest.image.name, tag)
  if (existing !== undefined) {
    const digest = existing
    if (digest !== manifest.image.digest) throw new Error('Immutable image tag conflict: use a new candidate')
  } else {
    run(
      'skopeo',
      [
        'copy',
        '--preserve-digests',
        '--authfile',
        authFile,
        process.env.PROMOTION_VERSION || manifest.imageSelection?.mode === 'reuse'
          ? `docker://${manifest.image.reference}`
          : `oci-archive:${join(directory, assetNames[1])}`,
        `docker://${destination}`,
      ],
      { stdio: 'inherit' },
    )
  }
  const digest = await registryDigest(manifest.image.name, tag)
  if (digest !== manifest.image.digest) throw new Error('Published registry digest mismatch')
  if (process.env.PROMOTION_VERSION && (await registryDigest(manifest.image.name, tag, { anonymous: true })) !== digest)
    throw new Error('Formal image anonymous verification failed')
  if (manifest.imageIdentity && !process.env.PROMOTION_VERSION) {
    const inputTag = `input-${manifest.imageIdentity.inputHash}`
    // The first successful image for these inputs remains the lookup target.
    // A forced rebuild gets its own candidate tag without rewriting this alias.
    if ((await registryDigest(manifest.image.name, inputTag)) === undefined) {
      run(
        'skopeo',
        ['copy', '--preserve-digests', '--authfile', authFile, `docker://${manifest.image.reference}`, `docker://${manifest.image.name}:${inputTag}`],
        { stdio: 'inherit' },
      )
      if ((await registryDigest(manifest.image.name, inputTag)) !== manifest.image.digest) throw Error('Image input tag publication mismatch')
    }
  }
  console.log(`Verified ${destination}@${digest}`)
} finally {
  await rm(authRoot, { recursive: true, force: true })
}
