// Reuse candidate bytes only when the two source trees differ in Harness or documentation.
import { readFile } from 'node:fs/promises'
import { matchesGlob, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sha256 } from './integrity.mjs'
import { api } from './process.mjs'
import { sourceRepository } from './candidate-source.mjs'

const table = JSON.parse(await readFile(new URL('../validation/t4-stages.json', import.meta.url), 'utf8'))
const record = path => path.startsWith('releases/acceptance/')
const harness = path => table.harness.some(pattern => matchesGlob(path, pattern))
const documentation = path => table.noStage.some(pattern => matchesGlob(path, pattern))

function entries(tree) {
  if (tree.truncated !== false || !Array.isArray(tree.tree)) throw Error('Complete source tree required for candidate reuse')
  const leaves = tree.tree.filter(entry => entry.type !== 'tree')
  if (leaves.some(entry => !['blob', 'commit'].includes(entry.type) || typeof entry.path !== 'string' ||
      !/^[a-f0-9]{40}$/u.test(entry.sha) || !/^\d{6}$/u.test(entry.mode))) throw Error('Invalid candidate source tree')
  return new Map(leaves.map(entry => [entry.path, `${entry.mode}:${entry.sha}`]))
}

export function harnessReusePlan(beforeTree, afterTree, blockingChecks = []) {
  const before = entries(beforeTree), after = entries(afterTree)
  const changed = [...new Set([...before.keys(), ...after.keys()])].sort().filter(path => before.get(path) !== after.get(path))
  const deliverable = changed.filter(path => !harness(path) && !documentation(path))
  if (deliverable.length) throw Error(`Candidate deliverables changed; rebuild required: ${deliverable.join(', ')}`)
  const executable = changed.filter(path => harness(path) && !record(path) && !documentation(path))
  const checks = new Set()
  for (const path of executable) {
    checks.add('ci') // The local check compiles and lints all Harness files.
    if (path.endsWith('.spec.ts') || path.startsWith('scripts/dev/')) continue
    if (path === 'tests/installer-ubuntu.e2e.ts') {
      if (blockingChecks.includes('cleanInstall')) checks.add('cleanInstall')
      continue
    }
    if (path === 'tests/installed-formal-upgrade.e2e.ts') { checks.add('upgrade'); continue }
    if (path.endsWith('.e2e.ts')) { checks.add('linux'); continue }
    // Shared subprocess fixtures and runner configuration can affect both installed stages.
    checks.add('linux'); checks.add('upgrade')
    if (blockingChecks.includes('cleanInstall')) checks.add('cleanInstall')
  }
  const inputs = [...after].filter(([path]) => harness(path) && !record(path) && !documentation(path)).sort(([a], [b]) => a.localeCompare(b))
  return { changed, checks: [...checks].sort(), inputDigest: sha256(JSON.stringify(inputs)) }
}

export function verifyHarnessReuse(source, head, acceptance, blockingChecks = []) {
  if (source === head) return
  const tree = commit => api(`repos/${sourceRepository}/git/trees/${commit}?recursive=1`)
  const plan = harnessReusePlan(tree(source), tree(head), blockingChecks)
  if (!plan.checks.length) return // Receipt and prose updates cannot require another candidate.
  const proof = acceptance?.harnessReuse
  if (proof?.builtSource !== source || proof.inputDigest !== plan.inputDigest ||
      !plan.checks.every(check => proof.reruns?.[check] === 'passed')) {
    throw Error(`Harness changes require recorded reruns for ${plan.checks.join(', ')} at input ${plan.inputDigest}`)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [source, head] = process.argv.slice(2)
  if (process.argv.length !== 4 || ![source, head].every(value => /^[a-f0-9]{40}$/u.test(value ?? ''))) {
    throw Error('Usage: node scripts/release/harness-reuse.mjs BUILT_SOURCE SNAPSHOT_HEAD')
  }
  const tree = commit => api(`repos/${sourceRepository}/git/trees/${commit}?recursive=1`)
  const blockingChecks = JSON.parse(await readFile('release-policy.json', 'utf8')).acceptancePolicy.checks
  console.log(JSON.stringify({ builtSource: source, ...harnessReusePlan(tree(source), tree(head), blockingChecks) }, null, 2))
}
