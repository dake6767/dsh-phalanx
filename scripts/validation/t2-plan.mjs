import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const selection = JSON.parse(readFileSync(new URL('./t2-selection.json', import.meta.url), 'utf8'))
export const inventoryHash = createHash('sha256').update(JSON.stringify(selection)).digest('hex')
export function validateFiles(files) {
  if (!files.length || new Set(files).size !== files.length || files.some(file => !selection.regular.includes(file)))
    throw Error('Select distinct regular T2 inventory files')
  return files
}
export function plan(files) {
  if (files) return { mode: 'subset', inventoryHash, shards: [{ index: 1, total: 1, files: validateFiles(files) }] }
  const shards = Array.from({ length: 4 }, (_, index) => ({ index: index + 1, total: 4, files: [], cases: 0 }))
  const ordered = [...selection.regular].sort((a, b) => selection.regularFileCases[b] - selection.regularFileCases[a] || a.localeCompare(b, 'en'))
  for (const file of ordered) {
    const shard = [...shards].sort((a, b) => a.cases - b.cases || a.index - b.index)[0]
    shard.files.push(file)
    shard.cases += selection.regularFileCases[file]
  }
  return { mode: 'full', inventoryHash, shards }
}
export function shardPlan(value) {
  if (!/^[1-4]\/4$/u.test(value)) throw Error('Expected shard INDEX/4, with INDEX between 1 and 4')
  return plan().shards[Number(value[0]) - 1]
}
function highImpact(path) {
  return (
    /^(?:containers\/|scripts\/(?:install|release|validation)\/|scripts\/download-sources\.py$|install\.sh$|runtime\/|runtime-versions\.json$|release-policy\.json$|package\.json$|pnpm-lock\.yaml$|\.node-version$|tsconfig.build\.json$|tests\/(?:support|fixtures)\/|vitest.*config\.|\.github\/workflows\/(?:linux-t2|candidate)\.yml$|src\/(?:dsh|composition)\/)/u.test(
      path,
    ) ||
    /^src\/adapters\/[^/]*(?:container|isolation|upgrade|system-update|runtime|process)/u.test(path) ||
    /^src\/inbound\/[^/]*(?:proxy|system-update)/u.test(path) ||
    /^src\/domain\/(?:system-update|download-source)/u.test(path) ||
    /^src\/(?:ports|use-cases)\/[^/]*(?:runtime|upgrade|system-update)/u.test(path)
  )
}
export function prPlan(base, head) {
  if (![base, head].every(value => /^[a-f0-9]{40}$/u.test(value))) return plan()
  const diff = spawnSync('git', ['diff', '--name-status', '--no-renames', base, head, '--'], { encoding: 'utf8' })
  if (diff.status !== 0) return plan()
  const rows = diff.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => line.split('\t'))
  if (rows.some(([status, path]) => highImpact(path) || (status === 'D' && selection.regular.includes(path)))) return plan()
  const files = rows.map(([, path]) => path).filter(path => selection.regular.includes(path))
  return files.length ? plan(files) : { mode: 'none', inventoryHash, shards: [] }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2),
    outputIndex = args.indexOf('--github-output')
  const output = outputIndex < 0 ? undefined : args.splice(outputIndex, 2)[1]
  let result
  if (!args.length) result = plan()
  else if (args.length === 2 && args[0] === '--files') result = plan(args[1].split(','))
  else if (args.length === 3 && args[0] === '--pr') result = prPlan(args[1], args[2])
  else throw Error('Usage: t2-plan.mjs [--files FILE,FILE | --pr BASE HEAD] [--github-output PATH]')
  if (output) appendFileSync(output, `mode=${result.mode}\nmatrix=${JSON.stringify({ include: result.shards })}\nplan=${JSON.stringify(result)}\n`)
  console.log(JSON.stringify(result))
}
