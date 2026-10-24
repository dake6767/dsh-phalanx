import { run } from './process.mjs'
import { candidateRef } from './candidate-source.mjs'

const git = args => run('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args])
export function advanceSnapshot(version, commit) {
  const candidate = candidateRef(version)
  if (!/^[a-f0-9]{40}$/u.test(commit ?? '') || git(['ls-remote', 'origin', candidate]).split(/\s/u)[0] !== commit) {
    throw Error('Publication requires the exact candidate HEAD')
  }
  git(['fetch', '--no-tags', 'origin', 'refs/heads/main'])
  const base = git(['rev-parse', 'FETCH_HEAD'])
  if (base === commit) return // Resume after an interrupted publication.
  if (git(['rev-list', '--parents', '-n', '1', commit]) !== `${commit} ${base}`) {
    throw Error('Public main must be the snapshot single parent')
  }
  git(['push', 'origin', `${commit}:refs/heads/main`])
}

export function removePublishedSnapshot(version, commit) {
  if (git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s/u)[0] !== commit) throw Error('Formal source is not public main')
  const ref = candidateRef(version)
  const current = git(['ls-remote', 'origin', ref]).split(/\s/u)[0]
  if (!current) return
  if (current !== commit) throw Error('A different candidate must not be deleted')
  git(['push', `--force-with-lease=${ref}:${commit}`, 'origin', `:${ref}`])
}
