import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetNames, verifyDirectory, fileHash } from './integrity.mjs'
import { run, api } from './process.mjs'
import { formalReleaseNotes } from './notes.mjs'
import { verifyRehearsal } from './rehearsal-contract.mjs'

const directory = process.argv[2]
const manifest = await verifyDirectory(directory, { tag: process.env.CANDIDATE_TAG, commit: process.env.CANDIDATE_SHA })
const promotion = process.env.PROMOTION_VERSION
const rehearsal = process.env.PROMOTION_REHEARSAL === 'true' ? await verifyRehearsal(directory, manifest) : undefined
const runCandidate = !promotion && !rehearsal && manifest.tag.startsWith('run-')
if (runCandidate && (process.env.GITHUB_REPOSITORY !== 'dake6767/dsh-phalanx' || process.env.GITHUB_RUN_ID !== manifest.runId ||
    process.env.CANDIDATE_SHA !== manifest.commit || process.env.CANDIDATE_TAG !== manifest.tag ||
    process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    !/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? ''))) {
  throw new Error('Candidate publication requires the matching source workflow run')
}
if (runCandidate) await writeFile(join(directory, 'candidate.json'), JSON.stringify({
  schema: 1, repository: 'dake6767/dsh-phalanx', candidate: manifest.tag, runId: manifest.runId,
  commit: manifest.commit, targetVersion: manifest.targetVersion, manifestSha256: await fileHash(join(directory, 'manifest.json')),
  workflow: { path: '.github/workflows/candidate.yml', commit: process.env.GITHUB_SHA, ref: process.env.GITHUB_REF },
}, null, 2) + '\n')
const repo = runCandidate || rehearsal ? 'dake6767/dsh-phalanx-candidates' : process.env.GITHUB_REPOSITORY
const tag = rehearsal ? `v${rehearsal.testVersion}` : promotion ? `v${promotion}` : manifest.tag
const references = api(`repos/${repo}/git/matching-refs/tags/${tag}`)
const reference = references.find(item => item.ref === `refs/tags/${tag}`)
let targetCommit = manifest.commit
if (runCandidate || rehearsal) {
  const repository = api(`repos/${repo}`)
  if (repository.private !== false || !/^[A-Za-z0-9._/-]+$/u.test(repository.default_branch)) throw new Error('Candidate repository must have a public metadata branch')
  const anchor = api(`repos/${repo}/git/ref/heads/${repository.default_branch}`).object
  if (anchor.type !== 'commit' || !/^[a-f0-9]{40}$/u.test(anchor.sha)) throw new Error('Invalid candidate metadata anchor')
  targetCommit = anchor.sha
  if (reference) {
    if (reference.object.type !== 'commit' || !/^[a-f0-9]{40}$/u.test(reference.object.sha)) throw new Error('Invalid existing candidate metadata tag')
    if (reference.object.sha !== anchor.sha && !['ahead', 'identical'].includes(api(`repos/${repo}/compare/${reference.object.sha}...${anchor.sha}`).status)) {
      throw new Error('Existing candidate tag is outside the metadata branch history')
    }
    targetCommit = reference.object.sha
  }
}
if (reference && (reference.object.type !== 'commit' || reference.object.sha !== targetCommit)) throw new Error('Immutable source tag conflict')
if (!reference) {
  if (!promotion && !runCandidate && !rehearsal) throw new Error('Missing candidate tag')
  api(`repos/${repo}/git/refs`, ['-X', 'POST', '-f', `ref=refs/tags/${tag}`, '-f', `sha=${targetCommit}`])
}
const names = [...(rehearsal ? ['rehearsal.json'] : []), ...assetNames, 'SHA256SUMS', 'manifest.json', ...(manifest.updaterAsset ? [manifest.updaterAsset.name] : []), ...(runCandidate ? ['candidate.json'] : []), ...(promotion ? ['acceptance.json', 'acceptance.md', 'release.json'] : [])]
const releases = api(`repos/${repo}/releases?per_page=100`, ['--paginate', '--slurp']).flat()
let release = releases.find(item => item.tag_name === tag)
if (!release) {
  release = api(`repos/${repo}/releases`, ['-X', 'POST', '-f', `tag_name=${tag}`, '-f', `target_commitish=${targetCommit}`,
    '-f', `name=${rehearsal ? `Unsupported rehearsal ${rehearsal.testVersion}` : runCandidate ? manifest.runId : `dsh-phalanx ${tag.slice(1)}`}`, '-f', `body=${rehearsal ? 'Publication rehearsal only. Not accepted for production; original candidate bytes and image digest are unchanged.' : promotion ? 'Accepted candidate promoted without rebuilding. See release.json and acceptance.md.' : runCandidate ? `Internal candidate, unsupported. Source commit: ${manifest.commit}. Workflow run: ${manifest.runId}. Verify SHA256SUMS and manifest before installation.` : 'Private preview candidate. Verify SHA256SUMS and manifest before installation.'}`,
    '-F', 'draft=true', '-F', `prerelease=${!promotion}`])
}
if (!release || release.prerelease !== !promotion) throw new Error('Release state conflict')
if (release.assets.some(asset => !names.includes(asset.name))) throw new Error('Unexpected release assets')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-phalanx-release-'))
try {
  if (promotion && release.draft) {
    const notes = join(temporary, 'notes.md')
    await writeFile(notes, formalReleaseNotes(repo, promotion))
    run('gh', ['release', 'edit', tag, '--repo', repo, '--notes-file', notes])
  }
  for (const name of names) {
    const existing = release.assets.find(asset => asset.name === name)
    if (existing) {
      run('gh', ['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', temporary])
      if (await fileHash(join(temporary, name)) !== await fileHash(join(directory, name))) throw new Error(`Immutable asset conflict: ${name}; resume the original build inputs or use a new candidate`)
    } else {
      if (!release.draft) throw new Error('Published release is incomplete; cannot mutate it')
      run('gh', ['release', 'upload', tag, join(directory, name), '--repo', repo])
      run('gh', ['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', temporary])
      if (await fileHash(join(temporary, name)) !== await fileHash(join(directory, name))) throw new Error(`Uploaded asset mismatch: ${name}; keep release draft`)
    }
  }
  const refreshed = api(`repos/${repo}/releases/${release.id}`)
  if (!names.every(name => refreshed.assets.some(asset => asset.name === name))) throw new Error('Partial upload: keep release draft')
  if (release.draft) run('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', `--latest=${Boolean(promotion)}`])
  console.log(`Complete ${tag}; all required assets verified`)
} finally { await rm(temporary, { recursive: true, force: true }) }
