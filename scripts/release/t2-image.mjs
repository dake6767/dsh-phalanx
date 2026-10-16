// Candidate consumes this artifact only after the producing native T2 job succeeds.
import { mkdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { assetNames, fileHash, validateManifest } from './integrity.mjs'

const [source, destination] = process.argv.slice(2)
if (!source || !destination || !process.env.CANDIDATE_SHA || !process.env.GITHUB_RUN_ID) {
  throw new Error('Usage: CANDIDATE_SHA=... GITHUB_RUN_ID=... node scripts/release/t2-image.mjs SOURCE DESTINATION')
}
const manifest = validateManifest(JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')), {
  commit: process.env.CANDIDATE_SHA,
})
if (manifest.runId !== process.env.GITHUB_RUN_ID) throw new Error('T2 image belongs to another workflow run')
const archive = assetNames[1]
const archiveSha256 = await fileHash(join(source, archive))
if (archiveSha256 !== manifest.files[archive]) throw new Error('T2 image archive checksum mismatch')
await mkdir(destination, { recursive: true })
await rename(join(source, archive), join(destination, archive))
console.log(JSON.stringify({ digest: manifest.image.digest, archiveSha256 }))
