import { mkdir } from 'node:fs/promises'
import { verifyDirectory } from './integrity.mjs'
import { api, run } from './process.mjs'

const repo = 'dake6767/dsh-phalanx'
const candidateRepo = `${repo}-candidates`

export function requirePublicationDispatch() {
  const repository = api(`repos/${repo}`)
  if (process.env.GITHUB_REPOSITORY !== repo || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      process.env.GITHUB_REF !== `refs/heads/${repository.default_branch}` || repository.private) {
    throw new Error('Publication requires default-branch dispatch and an already public repository')
  }
  return repository
}

export async function acquireCandidate(directory, candidateRun, { verifyExisting = false } = {}) {
  if (!/^[1-9]\d*$/u.test(candidateRun ?? '')) throw new Error('Invalid candidate run identity')
  const candidate = `run-${candidateRun}`
  const repository = requirePublicationDispatch()
  if (api(`repos/${candidateRepo}`).private !== false) throw new Error('Candidates must be publicly downloadable')
  const runRecord = api(`repos/${repo}/actions/runs/${candidateRun}`)
  if (String(runRecord.id) !== candidateRun || runRecord.status !== 'completed' || runRecord.conclusion !== 'success' ||
      runRecord.event !== 'workflow_dispatch' || runRecord.path !== '.github/workflows/candidate.yml' ||
      runRecord.head_branch !== repository.default_branch || !/^[a-f0-9]{40}$/u.test(runRecord.head_sha ?? '')) {
    throw new Error('Candidate run was not the successful trusted dispatch workflow')
  }
  const release = api(`repos/${candidateRepo}/releases/tags/${candidate}`)
  if (release.tag_name !== candidate || release.draft || !release.prerelease) throw new Error('Candidate release is incomplete')
  const ref = api(`repos/${candidateRepo}/git/ref/tags/${candidate}`).object
  if (ref.type !== 'commit' || !/^[a-f0-9]{40}$/u.test(ref.sha ?? '')) throw new Error('Invalid candidate metadata tag')
  await mkdir(directory, { recursive: true })
  if (!verifyExisting) run('gh', ['release', 'download', candidate, '--repo', candidateRepo, '--dir', directory])
  const manifest = await verifyDirectory(directory, { tag: candidate })
  if (manifest.runId !== candidateRun) throw new Error('Manifest and accepted candidate run or version differ')
  // The candidate repository's tag anchors metadata. Source must instead be in
  // the history of the trusted workflow revision that produced this run.
  const ancestry = api(`repos/${repo}/compare/${manifest.commit}...${runRecord.head_sha}`)
  if (!['ahead', 'identical'].includes(ancestry.status)) throw new Error('Candidate source is outside the trusted workflow history')
  const source = JSON.parse(Buffer.from(api(`repos/${repo}/contents/package.json?ref=${manifest.commit}`).content, 'base64').toString())
  if (source.version !== manifest.targetVersion) throw new Error('Source version mismatch')
  return manifest
}
