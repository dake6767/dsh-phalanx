import { api } from './process.mjs'
import { versionParts } from './compatibility.mjs'

export const sourceRepository = 'dake6767/dsh-phalanx'
export function candidateRef(version) {
  versionParts(version)
  return `refs/heads/candidate/${version}`
}

/** Check the current branch HEAD before granting publication capabilities. */
export function requireCandidateDispatch(version) {
  const ref = candidateRef(version), commit = process.env.GITHUB_SHA
  if (process.env.GITHUB_REPOSITORY !== sourceRepository || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      process.env.GITHUB_REF !== ref || !/^[a-f0-9]{40}$/u.test(commit ?? '')) {
    throw Error('Publication requires the matching candidate branch dispatch')
  }
  const repository = api(`repos/${sourceRepository}`)
  if (repository.private !== false) throw Error('Publication requires an already public source repository')
  const head = api(`repos/${sourceRepository}/git/ref/heads/candidate/${version}`).object
  if (head?.type !== 'commit' || head.sha !== commit) throw Error('Dispatch is no longer the candidate branch HEAD')
  return repository
}
