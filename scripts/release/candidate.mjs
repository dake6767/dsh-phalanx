import { appendFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyDirectory } from './integrity.mjs'
import { compareVersions } from './compatibility.mjs'
import { candidateRef } from './candidate-source.mjs'
import { run, api } from './process.mjs'

const tag = process.env.CANDIDATE_TAG, commit = process.env.CANDIDATE_SHA, runId = process.env.GITHUB_RUN_ID
const mode = process.argv[2]
if (!['verify', 'restore'].includes(mode) || !/^[a-f0-9]{40}$/u.test(commit ?? '') ||
    !/^[1-9]\d*$/u.test(runId ?? '') || tag !== `run-${runId}`) throw new Error('Expected an exact source commit and workflow run identity')
const checkout = run('git', ['rev-parse', 'HEAD'])
if (checkout !== commit || process.env.GITHUB_SHA !== commit) throw new Error('Candidate and workflow checkout must be the same snapshot')
const version = JSON.parse(run('git', ['show', `${commit}:package.json`])).version
const ref = candidateRef(version)
if (process.env.GITHUB_REPOSITORY !== 'dake6767/dsh-phalanx' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    process.env.GITHUB_REF !== ref || run('git', ['ls-remote', 'origin', ref]).split(/\s/u)[0] !== commit) {
  throw new Error('Candidate requires the exact candidate branch HEAD')
}
if (compareVersions(version, '0.1.16') < 0) throw new Error('This source predates run-addressed candidates')
if (mode === 'restore') {
  const directory = resolve(process.argv[3])
  await mkdir(directory, { recursive: true })
  const repository = 'dake6767/dsh-phalanx-candidates'
  // A failed request is never treated as absence; all pages are inspected.
  const releases = api(`repos/${repository}/releases?per_page=100`, ['--paginate', '--slurp']).flat()
  const existing = releases.find(release => release.tag_name === tag)
  let restored = false
  if (existing && !existing.draft) {
    if (!existing.prerelease) throw new Error('Candidate identity is already a stable release')
    run('gh', ['release', 'download', tag, '--repo', repository, '--dir', directory])
    await verifyDirectory(directory, { tag, commit })
    restored = true
  }
  await appendFile(process.env.GITHUB_OUTPUT, `restored=${restored}\n`)
} else {
  await appendFile(process.env.GITHUB_OUTPUT, `commit=${commit}\n`)
}
