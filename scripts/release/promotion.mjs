import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { candidatePattern, verifyDirectory, validateAcceptance, sha256 } from './integrity.mjs'
import { versionParts } from './compatibility.mjs'
import { api, run } from './process.mjs'

const repo = process.env.GITHUB_REPOSITORY
const candidate = process.env.CANDIDATE_TAG
const version = process.env.PROMOTION_VERSION
const candidateRun = process.env.CANDIDATE_RUN_ID
versionParts(version)
if (repo !== 'dake6767/dsh-phalanx' || !candidatePattern.test(candidate) || candidate.split('-rc.')[0] !== `v${version}` || !/^[1-9]\d*$/u.test(candidateRun)) throw new Error('Invalid promotion inputs')
const repository = api(`repos/${repo}`)
if (process.env.GITHUB_REF !== `refs/heads/${repository.default_branch}` || repository.private) throw new Error('Formal release requires default-branch dispatch and an already public repository')
const runRecord = api(`repos/${repo}/actions/runs/${candidateRun}`)
if (runRecord.status !== 'completed' || runRecord.conclusion !== 'success' || runRecord.event !== 'push' ||
    runRecord.path !== '.github/workflows/candidate.yml' || runRecord.head_branch !== candidate) throw new Error('Candidate run was not the successful trusted tag workflow')
const ref = api(`repos/${repo}/git/ref/tags/${candidate}`)
if (ref.object.type !== 'commit' || ref.object.sha !== runRecord.head_sha) throw new Error('Candidate tag identity changed')
const release = api(`repos/${repo}/releases/tags/${candidate}`)
if (release.draft || !release.prerelease) throw new Error('Candidate release is incomplete')
const directory = resolve(process.argv[2])
await mkdir(directory, { recursive: true })
if (process.argv[3] !== 'verify') run('gh', ['release', 'download', candidate, '--repo', repo, '--dir', directory])
const manifest = await verifyDirectory(directory, { tag: candidate, commit: ref.object.sha })
if (manifest.runId !== candidateRun) throw new Error('Manifest and accepted candidate run differ')
const source = JSON.parse(Buffer.from(api(`repos/${repo}/contents/package.json?ref=${ref.object.sha}`).content, 'base64').toString())
if (source.version !== version) throw new Error('Source version mismatch')
const acceptance = JSON.parse(await readFile(`releases/acceptance/${version}.json`, 'utf8'))
const summary = await readFile(`releases/acceptance/${version}.md`)
const acceptanceBytes = await readFile(`releases/acceptance/${version}.json`)
if (sha256(acceptanceBytes) !== process.env.ACCEPTANCE_SHA256) throw new Error('Acceptance record identity mismatch')
validateAcceptance(acceptance, manifest, sha256(summary))
await writeFile(join(directory, 'acceptance.json'), acceptanceBytes)
await writeFile(join(directory, 'acceptance.md'), summary)
await writeFile(join(directory, 'release.json'), JSON.stringify({ schema: 1, version,
  candidate, candidateRun, commit: manifest.commit, files: manifest.files,
  image: `${manifest.image.name}:${version}`, imageDigest: manifest.image.digest,
  acceptanceSha256: sha256(acceptanceBytes), summarySha256: sha256(summary),
}, null, 2) + '\n')
