import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { imageName, candidateImageTag, assetNamesFor, sha256, fileHash, validateManifest } from './integrity.mjs'
import { compareVersions } from './compatibility.mjs'
import { run } from './process.mjs'
import { imageInputs } from './image-inputs.mjs'

const directory = process.argv[2]
const developmentArm64 = process.argv.includes('--dev-arm64')
const architecture = developmentArm64 ? 'arm64' : 'amd64'
if (developmentArm64 && (process.platform !== 'linux' || process.arch !== 'arm64')) throw new Error('Development arm64 must be built natively on Linux arm64')
const platform = `linux/${architecture}`
const assetNames = assetNamesFor(platform)
const versions = JSON.parse(await readFile('runtime-versions.json', 'utf8'))
const tag = process.env.CANDIDATE_TAG
const selectionIndex = process.argv.indexOf('--image-selection')
const selection = selectionIndex === -1 ? undefined : JSON.parse(await readFile(process.argv[selectionIndex + 1], 'utf8'))
const config = JSON.parse(run('skopeo', ['inspect', '--config', `oci-archive:${join(directory, assetNames[1])}`]))
const inputs = await imageInputs('.', { platform, nodeImage: config.config.Labels['dsh.base.image'] })
if (config.config.Labels['dsh.input.sha256'] !== inputs.inputHash) throw new Error('Built image input hash mismatch')
if (config.os !== 'linux' || config.architecture !== architecture || config.config.User !== 'node' ||
    config.config.Labels['dsh.revision'] !== versions.dsh.revision ||
    (selection?.mode !== 'reuse' && config.config.Labels['org.opencontainers.image.revision'] !== run('git', ['rev-parse', 'HEAD']))) throw new Error('Built image platform, non-root user or revision mismatch')
// skopeo's --raw output must be hashed byte-for-byte, without trimming.
const raw = run('skopeo', ['inspect', '--raw', `oci-archive:${join(directory, assetNames[1])}`], { encoding: 'buffer' })
const imageDigest = `sha256:${sha256(raw)}`
const files = Object.fromEntries(await Promise.all(assetNames.map(async name => [name, await fileHash(join(directory, name))])))
const targetVersion = JSON.parse(await readFile('package.json', 'utf8')).version
const protocol = compareVersions(targetVersion, '0.1.2') >= 0 ? JSON.parse(await readFile('release-policy.json', 'utf8')) : undefined
if (protocol && compareVersions(targetVersion, '0.1.13') >= 0) protocol.compatibility.protocol = 3
const capacity = protocol?.compatibility.protocol === 3 ? JSON.parse(run('python3', ['scripts/release/storage.py', directory, architecture])) : {}
const manifest = validateManifest({ ...capacity, schema: protocol === undefined ? 1 : 2, ...protocol, tag, targetVersion,
  commit: run('git', ['rev-parse', 'HEAD']), platform,
  dshRevision: versions.dsh.revision, toolchain: { node: versions.node, pnpm: versions.pnpm },
  buildInputs: { nodeArchive: developmentArm64 ? versions.nodeLinuxArm64 : versions.nodeLinuxAmd64, nodeImage: config.config.Labels['dsh.base.image'],
    containerRecipeSha256: await fileHash('containers/dsh/Containerfile'), lockfileSha256: await fileHash('pnpm-lock.yaml') },
  imageSelection: selection ?? { ...inputs, mode: 'build', reason: 'local-build', rehearsal: false },
  imageIdentity: { inputHash: inputs.inputHash, dshRevision: inputs.dshRevision, digest: imageDigest, buildCommit: config.config.Labels['org.opencontainers.image.revision'] },
  updaterAsset: { name: 'updater.json', sha256: await fileHash(join(directory, 'updater.json')) },
  runId: process.env.GITHUB_RUN_ID,
  image: { name: imageName, tag: candidateImageTag(tag), digest: imageDigest, reference: `${imageName}@${imageDigest}` }, files,
}, { platform })
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
await writeFile(join(directory, 'SHA256SUMS'), assetNames.map(name => `${files[name]}  ${name}\n`).join(''))
