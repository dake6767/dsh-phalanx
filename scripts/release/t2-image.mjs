// Candidate consumes this artifact only after the producing native T2 job succeeds.
import { mkdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { assetNames, fileHash, validateManifest } from './integrity.mjs'

const [source, destination, option] = process.argv.slice(2)
if (option !== undefined && option !== '--include-platform') throw Error('Unknown T2 handoff option')
if (!source || !destination || !process.env.CANDIDATE_SHA || !process.env.GITHUB_RUN_ID) {
  throw new Error('Usage: CANDIDATE_SHA=... GITHUB_RUN_ID=... node scripts/release/t2-image.mjs SOURCE DESTINATION')
}
const manifest = validateManifest(JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')), {
  commit: process.env.CANDIDATE_SHA,
})
if (manifest.runId !== process.env.GITHUB_RUN_ID) throw new Error('T2 image belongs to another workflow run')
if (manifest.imageSelection && JSON.stringify(JSON.parse(await readFile(join(source, 'image-selection.json'), 'utf8'))) !== JSON.stringify(manifest.imageSelection)) throw Error('T2 image selection mismatch')
const archive = assetNames[1]
const archiveSha256 = await fileHash(join(source, archive))
if (archiveSha256 !== manifest.files[archive]) throw new Error('T2 image archive checksum mismatch')
const selected = [archive]
if (option === '--include-platform') {
  selected.push(assetNames[0])
  if (await fileHash(join(source, assetNames[0])) !== manifest.files[assetNames[0]]) throw Error('T2 platform archive checksum mismatch')
  if (manifest.updaterAsset) {
    if (await fileHash(join(source, manifest.updaterAsset.name)) !== manifest.updaterAsset.sha256) throw Error('T2 updater checksum mismatch')
    selected.push(manifest.updaterAsset.name)
  }
}
await mkdir(destination, { recursive: true })
for (const name of selected) await rename(join(source, name), join(destination, name))
console.log(JSON.stringify({ digest: manifest.image.digest, archiveSha256 }))
