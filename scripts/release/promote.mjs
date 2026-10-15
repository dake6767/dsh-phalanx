import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateManifest, validateAcceptance, sha256 } from './integrity.mjs'
import { api, run } from './process.mjs'

const runId = process.argv[2]
if (process.argv.length !== 3 || !/^[1-9]\d*$/u.test(runId ?? '')) throw new Error('Usage: node scripts/release/promote.mjs RUN_ID')
const repository = 'dake6767/dsh-phalanx', tag = `run-${runId}`
const temporary = await mkdtemp(join(tmpdir(), 'dsh-phalanx-promotion-'))
try {
  run('gh', ['release', 'download', tag, '--repo', `${repository}-candidates`, '--pattern', 'manifest.json', '--dir', temporary])
  const manifest = validateManifest(JSON.parse(await readFile(join(temporary, 'manifest.json'), 'utf8')), { tag })
  const branch = api(`repos/${repository}`).default_branch
  const version = manifest.targetVersion
  const bytes = name => Buffer.from(api(`repos/${repository}/contents/releases/acceptance/${version}.${name}?ref=${branch}`).content, 'base64')
  const acceptance = bytes('json'), summary = bytes('md')
  validateAcceptance(JSON.parse(acceptance.toString()), manifest, sha256(summary))
  run('gh', ['workflow', 'run', 'release.yml', '--repo', repository, '--ref', branch,
    '-f', `candidate_run=${runId}`, '-f', `version=${version}`, '-f', `acceptance_sha256=${sha256(acceptance)}`], { stdio: 'inherit' })
  console.log(`Dispatched promotion of ${tag} to v${version}; the Release workflow rechecks all identities before publication.`)
} finally { await rm(temporary, { recursive: true, force: true }) }
