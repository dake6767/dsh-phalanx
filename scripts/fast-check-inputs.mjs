import { spawnSync } from 'node:child_process'
import { evidenceIndexInputs } from './fast-check-policy.mjs'

/** Read the tracked snapshot; callers must separately require a clean tree. */
export function trackedEvidenceInputs(root) {
  const result = spawnSync('git', ['ls-files', '--stage', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error('could not read the Git index for validation evidence')
  const entries = result.stdout.split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755|120000) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t(.+)$/u.exec(line)
    if (match === null) throw new Error('validation evidence requires an unmerged tracked index')
    return { mode: match[1], oid: match[2], path: match[3] }
  })
  return evidenceIndexInputs(entries)
}
