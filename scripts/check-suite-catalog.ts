import { readFile } from 'node:fs/promises'
import { checkUnsignedSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { suiteCatalogViolations } from '../src/domain/suite-catalog-checks.js'
import { parseSemver, parseSemverRange, compareSemver } from '../src/domain/semver.js'
import { suiteCatalogAdapterNames } from '../src/domain/suite-catalog-adapters.js'

try {
  const [path, platformVersion, ...extra] = process.argv.slice(2)
  if (!path || !platformVersion || extra.length || !parseSemver(platformVersion))
    throw new Error('Usage: node --import tsx scripts/check-suite-catalog.ts <catalog.json> <platform-version>')
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  const result = checkUnsignedSuiteCatalog(raw, platformVersion)
  if (result.status !== 'ok') throw new Error(`${result.reason}: ${result.detail ?? ''}`)
  const violations = [
    ...result.rejected.map(row => `${row.id}: ${row.reason}: ${row.detail ?? ''}`),
    ...suiteCatalogViolations(result.entries.map(row => row.entry)),
  ]
  // These adapters first shipped together; no range branch may admit an older platform.
  const floor = parseSemver('0.1.19')!
  for (const entry of raw.entries as readonly { id: string; adapters?: readonly { name: string }[]; engines: { platform: string } }[]) {
    if (!entry.adapters?.some(call => (suiteCatalogAdapterNames as readonly string[]).includes(call.name))) continue
    const range = parseSemverRange(entry.engines.platform)
    if (!range || range.some(branch => !branch.some(bound => ['>', '>=', '='].includes(bound.operator) && compareSemver(bound.version, floor) >= 0))) {
      violations.push(`${entry.id}: adapters require engines.platform >=0.1.19`)
    }
  }
  if (violations.length) throw new Error(violations.join('\n'))
  console.log(`Catalog valid: ${result.entries.length} entries; ${result.skipped.length} reserved kinds skipped.`)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Catalog check failed.')
  process.exitCode = 1
}
