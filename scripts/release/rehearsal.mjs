import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { acquireCandidate } from './candidate-artifact.mjs'
import { rehearsalRecord, verifyRehearsal } from './rehearsal-contract.mjs'
import { assetNames, verifyDirectory, fileHash } from './integrity.mjs'
import { api, run } from './process.mjs'

const mode = process.argv[2], directory = resolve(process.argv[3] ?? '')
if (!['prepare', 'verify', 'cleanup'].includes(mode) || process.argv.length !== 4) throw new Error('Usage: rehearsal.mjs prepare|verify|cleanup DIRECTORY')
const repository = 'dake6767/dsh-phalanx-candidates'
if (mode === 'prepare') {
  const manifest = await acquireCandidate(directory, process.env.CANDIDATE_RUN_ID)
  const record = await rehearsalRecord(directory, manifest)
  await writeFile(join(directory, 'rehearsal.json'), JSON.stringify(record, null, 2) + '\n')
} else {
  const manifest = await verifyDirectory(directory, { tag: `run-${process.env.CANDIDATE_RUN_ID}` })
  const record = await verifyRehearsal(directory, manifest), tag = `v${record.testVersion}`
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-phalanx-rehearsal-'))
  try {
    if (mode === 'verify') {
      const names = ['rehearsal.json', 'manifest.json', 'SHA256SUMS', ...assetNames]
      for (const name of names) {
        run('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '3',
          `https://github.com/${repository}/releases/download/${tag}/${name}`, '--output', join(temporary, name)])
        if (await fileHash(join(temporary, name)) !== await fileHash(join(directory, name))) throw new Error(`Rehearsal changed bytes: ${name}`)
      }
      await verifyDirectory(temporary, { tag: manifest.tag, commit: manifest.commit })
      await verifyRehearsal(temporary, manifest)
      await writeFile(join(directory, 'rehearsal-verification.json'), JSON.stringify({ result: 'passed', repository, tag,
        runId: manifest.runId, commit: manifest.commit, files: manifest.files, imageDigest: manifest.image.digest,
        mainRepositoryMutated: false, acceptance: 'not-accepted' }, null, 2) + '\n')
    } else {
      const releases = api(`repos/${repository}/releases?per_page=100`, ['--paginate', '--slurp']).flat()
      const release = releases.find(item => item.tag_name === tag)
      if (release) {
        if (!release.prerelease) throw new Error('Refuse cleanup of a non-rehearsal stable release')
        await mkdir(temporary, { recursive: true })
        run('gh', ['release', 'download', tag, '--repo', repository, '--pattern', 'rehearsal.json', '--dir', temporary])
        if (await fileHash(join(temporary, 'rehearsal.json')) !== await fileHash(join(directory, 'rehearsal.json'))) throw new Error('Refuse cleanup of an unowned rehearsal')
        run('gh', ['release', 'delete', tag, '--repo', repository, '--yes'], { stdio: 'inherit' })
      }
      await writeFile(join(directory, 'rehearsal-cleanup.json'), JSON.stringify({ repository, tag, deleted: Boolean(release), candidateRetained: manifest.tag }, null, 2) + '\n')
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
