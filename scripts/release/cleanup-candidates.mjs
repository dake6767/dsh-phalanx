import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateManifest } from './integrity.mjs'
import { versionParts } from './compatibility.mjs'
import { api, run } from './process.mjs'
import { clearCandidateChannel } from './candidate-channel.mjs'

const args = process.argv.slice(2),
  rehearsal = args[0] === '--rehearsal'
if (rehearsal ? args.length !== 3 || args[2] !== '--yes' || !/^[1-9]\d*(?:,[1-9]\d*)*$/u.test(args[1]) : args.length !== 2 || args[1] !== '--yes') {
  throw Error('Usage: node scripts/release/cleanup-candidates.mjs VERSION --yes | --rehearsal RUN_ID[,RUN_ID] --yes')
}
const version = rehearsal ? undefined : args[0],
  requested = new Set(rehearsal ? args[1].split(',').map(id => `run-${id}`) : [])
if (rehearsal && requested.size !== args[1].split(',').length) throw Error('Duplicate rehearsal run')
if (!rehearsal) versionParts(version)
const repository = 'dake6767/dsh-phalanx',
  candidates = `${repository}-candidates`
const candidateGh = argv => run('gh', argv, { env: { ...process.env, GH_TOKEN: process.env.CANDIDATE_GH_TOKEN ?? process.env.GH_TOKEN } })
const formal = rehearsal ? undefined : api(`repos/${repository}/releases/tags/v${version}`)
if (formal && (formal.tag_name !== `v${version}` || formal.draft || formal.prerelease)) throw new Error('Candidate cleanup requires a completed formal release')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-phalanx-candidate-cleanup-'))
try {
  const readManifest = async (repo, tag) => {
    const path = join(temporary, repo.split('/')[1], tag)
    const argv = ['release', 'download', tag, '--repo', repo, '--pattern', 'manifest.json', '--dir', path]
    if (repo === candidates) candidateGh(argv)
    else run('gh', argv)
    return validateManifest(JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')))
  }
  const accepted = rehearsal ? undefined : await readManifest(repository, `v${version}`)
  if (accepted && (accepted.targetVersion !== version || !accepted.tag.startsWith('run-'))) throw new Error('Formal release is not a run-addressed promotion')
  const releases = JSON.parse(candidateGh(['api', `repos/${candidates}/releases?per_page=100`, '--paginate', '--slurp'])).flat()
  const selected = [],
    retained = new Set(accepted ? [accepted.image.digest] : []),
    allowedTags = new Map()
  // Inspect all formal and candidate references before either kind of deletion.
  const formals = api(`repos/${repository}/releases?per_page=100`, ['--paginate', '--slurp']).flat()
  for (const release of formals) {
    if (release.draft || release.prerelease) continue
    const manifest = release.tag_name === formal?.tag_name ? accepted : await readManifest(repository, release.tag_name)
    if (release.tag_name !== `v${manifest.targetVersion}`) throw Error('Formal release version mismatch')
    retained.add(manifest.image.digest)
  }
  for (const release of releases) {
    const manifest = await readManifest(candidates, release.tag_name)
    const removable = !release.draft && release.prerelease && /^run-[1-9]\d*$/u.test(release.tag_name)
    if (removable && manifest.tag !== release.tag_name) throw Error('Candidate tag mismatch')
    if (!removable || (rehearsal ? !requested.has(release.tag_name) : manifest.targetVersion !== version)) {
      retained.add(manifest.image.digest)
      continue
    }
    if (rehearsal && manifest.imageSelection?.rehearsal !== true) throw Error('Only explicitly marked reuse rehearsals may be removed before formal release')
    selected.push(manifest)
    const tags = allowedTags.get(manifest.image.digest) ?? new Set()
    tags.add(manifest.image.tag)
    if (manifest.imageIdentity) tags.add(`input-${manifest.imageIdentity.inputHash}`)
    allowedTags.set(manifest.image.digest, tags)
  }
  if (rehearsal && (selected.length !== requested.size || new Set(selected.map(manifest => manifest.targetVersion)).size !== 1)) {
    throw Error('Every requested rehearsal must be completed and target the same version')
  }
  const packagePath = 'users/dake6767/packages/container/dsh-phalanx/versions'
  const versions = api(`${packagePath}?per_page=100`, ['--paginate', '--slurp']).flat()
  const images = [],
    retainedImages = []
  for (const entry of versions) {
    if (!allowedTags.has(entry.name)) continue
    const tags = entry.metadata?.container?.tags
    if (!Number.isSafeInteger(entry.id) || entry.id < 1 || !Array.isArray(tags) || !tags.every(tag => typeof tag === 'string'))
      throw Error('Invalid package version metadata')
    if (retained.has(entry.name) || tags.some(tag => !allowedTags.get(entry.name).has(tag))) {
      retainedImages.push({ id: entry.id, digest: entry.name, tags, reason: retained.has(entry.name) ? 'retained release reference' : 'other image tags' })
      continue
    }
    images.push({ id: entry.id, digest: entry.name, tags })
  }
  console.log(JSON.stringify({ releases: selected.map(manifest => manifest.tag), images, retainedImages }))
  await clearCandidateChannel(selected, (path, options = []) => JSON.parse(candidateGh(['api', path, ...options])))
  // Delete images first: a failed deletion leaves its manifests available for retry.
  for (const image of images) run('gh', ['api', `${packagePath}/${image.id}`, '--method', 'DELETE'], { stdio: 'inherit' })
  for (const manifest of selected) candidateGh(['release', 'delete', manifest.tag, '--repo', candidates, '--yes'])
  console.log(
    `Deleted ${selected.length} candidate releases and ${images.length} unreferenced images for ${version ?? 'the selected rehearsals'}; formal releases and retained references preserved.`,
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
