import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function acceptanceSummary(manifest) {
  if (!/^[1-9]\d*$/u.test(manifest.runId ?? '') || !/^sha256:[a-f0-9]{64}$/u.test(manifest.image?.digest ?? '')) {
    throw Error('Acceptance summary requires the exact run and image digest')
  }
  return `Accepted.\n\nRun: ${manifest.runId}.\n\nImage digest: ${manifest.image.digest}.\n`
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw Error('Usage: node scripts/release/acceptance-summary.mjs MANIFEST_JSON')
  process.stdout.write(acceptanceSummary(JSON.parse(await readFile(process.argv[2], 'utf8'))))
}
