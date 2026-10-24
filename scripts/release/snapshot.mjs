// Publish only the release tree and notes, with public main as its single parent.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { run } from './process.mjs'
import { versionParts } from './compatibility.mjs'

if (process.argv.length !== 2) throw Error('Usage: node scripts/release/snapshot.mjs')
const version = JSON.parse(await readFile('package.json', 'utf8')).version
versionParts(version)
if (run('git', ['branch', '--show-current']) !== `release/${version}` || run('git', ['status', '--porcelain'])) {
  throw Error('Snapshot requires the clean matching release branch')
}
const head = run('git', ['rev-parse', 'HEAD'])
const state = process.env.DSH_PHALANX_VALIDATION_STATE_ROOT ?? join(homedir(), '.local/state/dsh-phalanx-validation')
const check = JSON.parse(await readFile(join(state, 'local-check', `${head}.json`), 'utf8'))
if (check.protocol !== 'local-check-v1' || check.commit !== head || check.status !== 'passed' || check.clean !== true ||
    !['fast-check', 'documentation', 'browser'].every(name => check.stages?.some(stage => stage.name === name && stage.status === 'passed'))) throw Error('Snapshot requires a passing local check record for this commit')
const notes = await readFile(`releases/notes/${version}.md`, 'utf8')
if (notes.match(/^#\s+v?(\d+\.\d+\.\d+)\s*$/mu)?.[1] !== version || /\bcodex\/|\bticket\s*#?\d+|第\s*\d+\s*票/iu.test(notes)) {
  throw Error('Snapshot requires version release notes without internal ticket identities')
}
const branch = `refs/heads/candidate/${version}`
run('git', ['fetch', '--no-tags', 'public', 'refs/heads/main'])
const parent = run('git', ['rev-parse', 'FETCH_HEAD'])
const policy = JSON.parse(await readFile('release-policy.json', 'utf8')).acceptancePolicy
const installerChanged = run('git', ['diff', '--name-only', parent, head, '--', 'install.sh', 'scripts/install']) !== ''
if (installerChanged && !policy.checks.includes('cleanInstall')) throw Error('Installer changes require cleanInstall in the blocking policy')
if (run('git', ['rev-parse', 'HEAD']) !== head || run('git', ['status', '--porcelain'])) throw Error('Release tree changed during snapshot preparation')
const previous = run('git', ['ls-remote', 'public', branch]).split(/\s/u)[0]
const tree = run('git', ['rev-parse', `${head}^{tree}`])
const snapshot = run('git', ['commit-tree', tree, '-p', parent], { input: `Release ${version}\n\n${notes.trim()}\n`, stdio: ['pipe', 'pipe', 'inherit'] })
// A branch changed by another publisher is never overwritten accidentally.
run('git', ['push', `--force-with-lease=${branch}:${previous}`, 'public', `${snapshot}:${branch}`])
console.log(snapshot)
