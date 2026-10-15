import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateManifest } from './integrity.mjs'
import { versionParts } from './compatibility.mjs'
import { api, run } from './process.mjs'

const version = process.argv[2]
versionParts(version)
if (process.argv.length !== 4 || process.argv[3] !== '--yes') throw new Error('Usage: node scripts/release/cleanup-candidates.mjs VERSION --yes')
const repository = 'dake6767/dsh-phalanx', candidates = `${repository}-candidates`
const formal = api(`repos/${repository}/releases/tags/v${version}`)
if (formal.tag_name !== `v${version}` || formal.draft || formal.prerelease) throw new Error('Candidate cleanup requires a completed formal release')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-phalanx-candidate-cleanup-'))
try {
  run('gh', ['release', 'download', `v${version}`, '--repo', repository, '--pattern', 'manifest.json', '--dir', temporary])
  const accepted = validateManifest(JSON.parse(await readFile(join(temporary, 'manifest.json'), 'utf8')))
  if (accepted.targetVersion !== version || !accepted.tag.startsWith('run-')) throw new Error('Formal release is not a run-addressed promotion')
  const releases = api(`repos/${candidates}/releases?per_page=100`, ['--paginate', '--slurp']).flat()
  const selected = []
  // Inspect every candidate first; a failed or incomplete read performs no deletion.
  for (const release of releases) {
    if (release.draft || !release.prerelease || !/^run-[1-9]\d*$/u.test(release.tag_name)) continue
    const path = join(temporary, release.tag_name)
    run('gh', ['release', 'download', release.tag_name, '--repo', candidates, '--pattern', 'manifest.json', '--dir', path])
    const manifest = validateManifest(JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')), { tag: release.tag_name })
    if (manifest.targetVersion === version) selected.push(release.tag_name)
  }
  for (const tag of selected) run('gh', ['release', 'delete', tag, '--repo', candidates, '--yes'], { stdio: 'inherit' })
  console.log(`Deleted ${selected.length} candidate releases for ${version}; source repository and tags retained.`)
} finally { await rm(temporary, { recursive: true, force: true }) }
