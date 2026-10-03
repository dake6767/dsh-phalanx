import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { imageName, assetNames, sha256, fileHash, validateManifest } from './integrity.mjs'
import { run } from './process.mjs'

const directory = process.argv[2]
const versions = JSON.parse(await readFile('runtime-versions.json', 'utf8'))
const tag = process.env.CANDIDATE_TAG
// skopeo's --raw output must be hashed byte-for-byte, without trimming.
const raw = run('skopeo', ['inspect', '--raw', `oci-archive:${join(directory, assetNames[1])}`], { encoding: 'buffer' })
const imageDigest = `sha256:${sha256(raw)}`
const files = Object.fromEntries(await Promise.all(assetNames.map(async name => [name, await fileHash(join(directory, name))])))
const manifest = validateManifest({ schema: 1, tag, targetVersion: '0.1.0',
  commit: run('git', ['rev-parse', 'HEAD']), platform: 'linux/amd64',
  dshRevision: versions.dsh.revision, toolchain: { node: versions.node, pnpm: versions.pnpm },
  runId: process.env.GITHUB_RUN_ID,
  image: { name: imageName, tag: tag?.slice(1), digest: imageDigest, reference: `${imageName}@${imageDigest}` }, files,
})
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
await writeFile(join(directory, 'SHA256SUMS'), assetNames.map(name => `${files[name]}  ${name}\n`).join(''))
