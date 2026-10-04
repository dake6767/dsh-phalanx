import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { candidatePattern, verifyDirectory } from './integrity.mjs'
import { run, api } from './process.mjs'

const tag = process.env.CANDIDATE_TAG
if (!candidatePattern.test(tag)) throw new Error('Expected v0.1.0-rc.N or v0.1.1-rc.N, N >= 1')
const commit = run('git', ['rev-parse', `${tag}^{commit}`])
if (commit !== process.env.GITHUB_SHA || commit !== run('git', ['rev-parse', 'HEAD'])) throw new Error('Candidate checkout must match the exact event SHA')
run('git', ['merge-base', '--is-ancestor', commit, 'origin/main'])
const version = JSON.parse(await readFile('package.json', 'utf8')).version
if (version !== tag.split('-rc.')[0].slice(1)) throw new Error('Candidate source version must match its tag')
const repo = process.env.GITHUB_REPOSITORY
if (repo !== 'dake6767/dsh-phalanx') throw new Error('Unexpected repository')
const remote = api(`repos/${repo}/git/ref/tags/${tag}`)
if (remote.object.type !== 'commit' || remote.object.sha !== commit) throw new Error('Candidate requires an immutable lightweight tag pointing at the event commit')
if (process.argv[2] === 'restore') {
  const directory = resolve(process.argv[3])
  await mkdir(directory, { recursive: true })
  // Query the release list successfully first: auth/network errors are not absence.
  const releases = api(`repos/${repo}/releases?per_page=100`)
  const existing = releases.find(release => release.tag_name === tag)
  let restored = false
  if (existing && !existing.draft) {
    if (!existing.prerelease) throw new Error('Candidate tag is already a stable release')
    run('gh', ['release', 'download', tag, '--repo', repo, '--dir', directory])
    await verifyDirectory(directory, { tag, commit })
    restored = true
  }
  await appendFile(process.env.GITHUB_OUTPUT, `restored=${restored}\n`)
} else if (process.argv[2] !== 'verify') throw new Error('Expected verify or restore')
