import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { imageName, assetNames, sha256, fileHash, validateManifest } from './integrity.mjs'
import { run } from './process.mjs'

const directory = process.argv[2]
const versions = JSON.parse(await readFile('runtime-versions.json', 'utf8'))
const tag = process.env.CANDIDATE_TAG
const config = JSON.parse(run('skopeo', ['inspect', '--config', `oci-archive:${join(directory, assetNames[1])}`]))
if (config.os !== 'linux' || config.architecture !== 'amd64' || config.config.User !== 'node' ||
    config.config.Labels['dsh.revision'] !== versions.dsh.revision ||
    config.config.Labels['org.opencontainers.image.revision'] !== run('git', ['rev-parse', 'HEAD'])) throw new Error('Built image platform, non-root user or revision mismatch')
// skopeo's --raw output must be hashed byte-for-byte, without trimming.
const raw = run('skopeo', ['inspect', '--raw', `oci-archive:${join(directory, assetNames[1])}`], { encoding: 'buffer' })
const imageDigest = `sha256:${sha256(raw)}`
const files = Object.fromEntries(await Promise.all(assetNames.map(async name => [name, await fileHash(join(directory, name))])))
const manifest = validateManifest({ schema: 1, tag, targetVersion: JSON.parse(await readFile('package.json', 'utf8')).version,
  commit: run('git', ['rev-parse', 'HEAD']), platform: 'linux/amd64',
  dshRevision: versions.dsh.revision, toolchain: { node: versions.node, pnpm: versions.pnpm },
  buildInputs: { nodeArchive: versions.nodeLinuxAmd64, nodeImage: config.config.Labels['dsh.base.image'],
    containerRecipeSha256: await fileHash('containers/dsh/Containerfile'), lockfileSha256: await fileHash('pnpm-lock.yaml') },
  runId: process.env.GITHUB_RUN_ID,
  image: { name: imageName, tag: tag?.slice(1), digest: imageDigest, reference: `${imageName}@${imageDigest}` }, files,
})
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
await writeFile(join(directory, 'SHA256SUMS'), assetNames.map(name => `${files[name]}  ${name}\n`).join(''))
