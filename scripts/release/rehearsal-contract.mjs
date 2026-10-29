import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requireCandidateDispatch } from './candidate-source.mjs'
import { fileHash } from './integrity.mjs'

export async function rehearsalRecord(directory, manifest) {
  requireCandidateDispatch(manifest.targetVersion)
  if (
    process.env.PROMOTION_REHEARSAL !== 'true' ||
    process.env.PROMOTION_VERSION ||
    process.env.GITHUB_REPOSITORY !== 'dake6767/dsh-phalanx' ||
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    process.env.GITHUB_WORKFLOW !== 'Candidate rehearsal' ||
    process.env.CANDIDATE_RUN_ID !== manifest.runId ||
    manifest.tag !== `run-${manifest.runId}`
  ) {
    throw new Error('Rehearsal requires its trusted candidate-branch workflow and exact candidate run')
  }
  return {
    purpose: 'publication-rehearsal',
    acceptance: 'not-accepted',
    candidate: manifest.tag,
    runId: manifest.runId,
    commit: manifest.commit,
    testVersion: `${manifest.targetVersion}-rehearsal.${manifest.runId}`,
    manifestSha256: await fileHash(join(directory, 'manifest.json')),
  }
}

export async function verifyRehearsal(directory, manifest) {
  const expected = await rehearsalRecord(directory, manifest)
  const actual = JSON.parse(await readFile(join(directory, 'rehearsal.json'), 'utf8'))
  if (Object.keys(actual).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
    throw new Error('Rehearsal record identity mismatch')
  }
  return expected
}
