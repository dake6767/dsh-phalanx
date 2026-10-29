import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyRegular } from './verify-linux-results.mjs'
import { plan, inventoryHash } from './t2-plan.mjs'
import { validateManifest, fileHash, assetNames } from '../release/integrity.mjs'

const read = path => JSON.parse(readFileSync(path, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export async function bundleIdentity(directory, commit, runId, runAttempt) {
  const manifestBytes = readFileSync(join(directory, 'manifest.json'))
  const manifest = validateManifest(JSON.parse(manifestBytes), { commit })
  if (manifest.runId !== runId || !/^[1-9][0-9]*$/u.test(runAttempt)) throw Error('Bundle workflow identity mismatch')
  const archiveSha256 = await fileHash(join(directory, assetNames[1]))
  const platformSha256 = await fileHash(join(directory, assetNames[0]))
  if (archiveSha256 !== manifest.files[assetNames[1]] || platformSha256 !== manifest.files[assetNames[0]]) throw Error('Bundle byte identity mismatch')
  if (manifest.imageSelection && JSON.stringify(read(join(directory, 'image-selection.json'))) !== JSON.stringify(manifest.imageSelection))
    throw Error('Image selection mismatch')
  return { sourceCommit: commit, runId, runAttempt, manifestSha256: hash(manifestBytes), archiveSha256, platformSha256 }
}
export function record(directory, shard, identity, regularReport) {
  writeFileSync(
    join(directory, 'shard.json'),
    JSON.stringify({
      ...shard,
      inventoryHash,
      identity,
      regularReport: basename(regularReport),
    }) + '\n',
  )
}
export function verify(directory, identity, expectedPlan) {
  if (
    !identity ||
    Object.keys(identity).length !== 6 ||
    !/^[a-f0-9]{40}$/u.test(identity.sourceCommit) ||
    ![identity.runId, identity.runAttempt].every(value => /^[1-9][0-9]*$/u.test(value)) ||
    ![identity.manifestSha256, identity.archiveSha256, identity.platformSha256].every(value => /^[a-f0-9]{64}$/u.test(value))
  )
    throw Error('Invalid expected artifact identity')
  const expected = expectedPlan.mode === 'full' ? plan() : plan(expectedPlan.shards[0]?.files)
  if (JSON.stringify(expectedPlan) !== JSON.stringify(expected)) throw Error('Unexpected shard plan')
  const paths = readdirSync(directory, { recursive: true }).filter(path => basename(path) === 'shard.json')
  if (paths.length !== expected.shards.length) throw Error('Missing or duplicate shard receipt')
  const seen = new Set()
  for (const path of paths) {
    const root = dirname(join(directory, path)),
      receipt = read(join(directory, path))
    const shard = expected.shards.find(row => row.index === receipt.index)
    if (
      !shard ||
      seen.has(receipt.index) ||
      receipt.inventoryHash !== inventoryHash ||
      Object.entries(shard).some(([key, value]) => JSON.stringify(receipt[key]) !== JSON.stringify(value)) ||
      Object.keys(identity).some(key => receipt.identity?.[key] !== identity[key])
    )
      throw Error('Shard assignment or artifact identity mismatch')
    seen.add(receipt.index)
    const report = name => {
      if (typeof name !== 'string' || name !== basename(name) || !/^linux(?:-confirmed)?\.json$/u.test(name)) throw Error('Invalid shard report path')
      return read(join(root, name))
    }
    verifyRegular(report(receipt.regularReport), shard.files)
    const cleanup = read(join(root, 'cleanup.json'))
    if (cleanup.result !== 'passed' || !Array.isArray(cleanup.errors) || cleanup.errors.length) throw Error('Shard cleanup did not pass')
  }
  return { result: 'passed', mode: expected.mode, shards: seen.size, identity, inventoryHash }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'identity' && args.length === 4) console.log(JSON.stringify(await bundleIdentity(...args)))
  else if (command === 'verify' && args.length === 3) console.log(JSON.stringify(verify(args[0], read(args[1]), read(args[2]))))
  else throw Error('Usage: t2-shards.mjs identity BUNDLE COMMIT RUN ATTEMPT | verify RESULTS IDENTITY PLAN')
}
