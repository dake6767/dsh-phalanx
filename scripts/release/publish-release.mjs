import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetNames, verifyDirectory, fileHash } from './integrity.mjs'
import { run, api } from './process.mjs'

const directory = process.argv[2]
const manifest = await verifyDirectory(directory, { tag: process.env.CANDIDATE_TAG, commit: process.env.CANDIDATE_SHA })
const repo = process.env.GITHUB_REPOSITORY
const promotion = process.env.PROMOTION_VERSION
const tag = promotion ? `v${promotion}` : manifest.tag
const references = api(`repos/${repo}/git/matching-refs/tags/${tag}`)
const reference = references.find(item => item.ref === `refs/tags/${tag}`)
if (reference && (reference.object.type !== 'commit' || reference.object.sha !== manifest.commit)) throw new Error('Immutable source tag conflict')
if (!reference) {
  if (!promotion) throw new Error('Missing candidate tag')
  api(`repos/${repo}/git/refs`, ['-X', 'POST', '-f', `ref=refs/tags/${tag}`, '-f', `sha=${manifest.commit}`])
}
const names = [...assetNames, 'SHA256SUMS', 'manifest.json', ...(promotion ? ['acceptance.json', 'acceptance.md', 'release.json'] : [])]
const releases = api(`repos/${repo}/releases?per_page=100`)
let release = releases.find(item => item.tag_name === tag)
if (!release) {
  run('gh', ['release', 'create', tag, '--repo', repo, '--draft', '--verify-tag', '--title', `dsh-phalanx ${tag.slice(1)}`,
    '--notes', promotion ? 'Accepted candidate promoted without rebuilding. See release.json and acceptance.md.' : 'Private preview candidate. Install package and OCI archive must pass SHA256SUMS and manifest verification.',
    ...(promotion ? [] : ['--prerelease'])])
  release = api(`repos/${repo}/releases?per_page=100`).find(item => item.tag_name === tag)
}
if (!release || release.prerelease !== !promotion) throw new Error('Release state conflict')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-phalanx-release-'))
try {
  for (const name of names) {
    const existing = release.assets.find(asset => asset.name === name)
    if (existing) {
      run('gh', ['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', temporary])
      if (await fileHash(join(temporary, name)) !== await fileHash(join(directory, name))) throw new Error(`Immutable asset conflict: ${name}; resume the original build inputs or use a new candidate`)
    } else {
      if (!release.draft) throw new Error('Published release is incomplete; cannot mutate it')
      run('gh', ['release', 'upload', tag, join(directory, name), '--repo', repo])
    }
  }
  const refreshed = api(`repos/${repo}/releases/${release.id}`)
  if (!names.every(name => refreshed.assets.some(asset => asset.name === name))) throw new Error('Partial upload: keep release draft')
  if (release.draft) run('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest=false'])
  console.log(`Complete ${tag}; all required assets verified`)
} finally { await rm(temporary, { recursive: true, force: true }) }
