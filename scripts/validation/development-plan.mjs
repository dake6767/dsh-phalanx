// Compare complete local snapshot trees using the same Harness classification as Candidate.
import { readFileSync } from 'node:fs'
import { harnessReusePlan } from '../release/harness-reuse.mjs'
const [before, after] = process.argv.slice(2).map(path => JSON.parse(readFileSync(path, 'utf8')))
try {
  const plan = harnessReusePlan(before, after)
  if (plan.changed.includes('scripts/validation/t4-stages.json')) throw Error('Classification rules changed; rebuild required')
  const files = after.tree.filter(row => row.path.endsWith('.e2e.ts')).map(row => row.path)
  const fileInputs = Object.fromEntries(files.map(file => {
    const scoped = { truncated: false, tree: after.tree.filter(row => !row.path.endsWith('.spec.ts') && (!row.path.endsWith('.e2e.ts') || row.path === file)) }
    return [file, harnessReusePlan(scoped, scoped).inputDigest]
  }))
  console.log(JSON.stringify({ rebuild: false, ...plan, fileInputs }))
} catch (error) {
  console.log(JSON.stringify({ rebuild: true, reason: error.message }))
}
