import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { validateAcceptance, sha256 } from './integrity.mjs'
import { acceptanceSummary } from './acceptance-summary.mjs'
import { compareVersions, versionParts } from './compatibility.mjs'
import { formatReleaseNotes } from './notes.mjs'
import { acquireCandidate } from './candidate-artifact.mjs'

const repo = process.env.GITHUB_REPOSITORY
const version = process.env.PROMOTION_VERSION
const candidateRun = process.env.CANDIDATE_RUN_ID
versionParts(version)
if (repo !== 'dake6767/dsh-phalanx' || !/^[1-9]\d*$/u.test(candidateRun ?? '')) throw new Error('Invalid promotion inputs')
const candidate = `run-${candidateRun}`
const directory = resolve(process.argv[2])
const acceptance = JSON.parse(await readFile(`releases/acceptance/${version}.json`, 'utf8'))
const manifest = await acquireCandidate(directory, candidateRun, { verifyExisting: process.argv[3] === 'verify', acceptance })
if (manifest.targetVersion !== version) throw new Error('Manifest and accepted version differ')
const summary = await readFile(`releases/acceptance/${version}.md`)
if (compareVersions(version, '0.1.24') >= 0 && summary.toString() !== acceptanceSummary(manifest))
  throw Error('Acceptance summary must contain only the conclusion, run and digest')
const acceptanceBytes = await readFile(`releases/acceptance/${version}.json`)
if (sha256(acceptanceBytes) !== process.env.ACCEPTANCE_SHA256) throw new Error('Acceptance record identity mismatch')
validateAcceptance(acceptance, manifest, sha256(summary))
await writeFile(join(directory, 'acceptance.json'), acceptanceBytes)
await writeFile(join(directory, 'acceptance.md'), summary)
await writeFile(
  join(directory, 'release.json'),
  JSON.stringify(
    {
      schema: 1,
      version,
      releaseNotes: formatReleaseNotes(repo, version, await readFile(`releases/notes/${version}.md`, 'utf8')),
      candidate,
      candidateRun,
      commit: manifest.commit,
      files: manifest.files,
      image: `${manifest.image.name}:${version}`,
      imageDigest: manifest.image.digest,
      acceptanceSha256: sha256(acceptanceBytes),
      summarySha256: sha256(summary),
    },
    null,
    2,
  ) + '\n',
)
