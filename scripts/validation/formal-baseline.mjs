// The formal previous release is the newest formal acceptance record. An
// upgrade from it exists only once the source version has moved past it.
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareVersions } from '../release/compatibility.mjs'

/** Suffixed records (`-web`, `-local`) are not formal releases. The previous formal must be a declared upgrade source. */
export function formalUpgradeScope(records, target, source) {
  const previous = records.flatMap(name => /^(\d+\.\d+\.\d+)\.json$/u.exec(name)?.[1] ?? []).sort(compareVersions).at(-1)
  if (previous === undefined || compareVersions(previous, target) >= 0) return { target, previous, upgrade: false }
  if (compareVersions(source.min, previous) > 0 || compareVersions(previous, source.maxExclusive) >= 0)
    throw new Error(`Previous formal ${previous} is outside the declared upgrade source ${source.min}..${source.maxExclusive}`)
  return { target, previous, upgrade: true }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (!(args.length === 0 || (args.length === 2 && args[0] === '--github-output'))) throw new Error('Usage: node scripts/validation/formal-baseline.mjs [--github-output FILE]')
  const target = JSON.parse(readFileSync('package.json', 'utf8')).version
  const source = JSON.parse(readFileSync('release-policy.json', 'utf8')).compatibility.source
  const scope = formalUpgradeScope(readdirSync('releases/acceptance'), target, source)
  console.log(JSON.stringify(scope))
  if (args[1]) appendFileSync(args[1], `upgrade=${scope.upgrade}\nprevious=${scope.previous ?? ''}\n`)
}
