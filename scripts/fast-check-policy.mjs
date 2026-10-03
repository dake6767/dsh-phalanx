import { createHash } from 'node:crypto'

export const FAST_CHECK_BUDGET_MS = 5 * 60 * 1000

/** A file-scoped evidence key; unrelated tests and documentation never enter it. */
export function evidenceInputDigest(inputs, files) {
  const shared = [inputs.productDigest, inputs.imageId, inputs.runnerDigest, inputs.configDigest, inputs.sharedTestDigest]
  if (shared.some(value => typeof value !== 'string' || value === '')) throw new Error('missing shared evidence input')
  const tests = [...new Set(files)].sort().map(file => {
    const digest = inputs.tests?.[file]
    if (typeof digest !== 'string' || digest === '') throw new Error(`missing test evidence input: ${file}`)
    return [file, digest]
  })
  return createHash('sha256').update(JSON.stringify([shared, tests])).digest('hex')
}

/** Typecheck and lint compile/inspect real-seam files too. */
export function fastCheckEvidenceDigest(inputs) {
  return evidenceInputDigest(inputs, Object.keys(inputs.tests ?? {}))
}

/** Reuse a passed stage without re-running unrelated work. */
export function fastCheckStageDigest(inputs, stage) {
  const files = Object.keys(inputs.tests ?? {})
  if (stage === 'typecheck' || stage === 'lint') return evidenceInputDigest(inputs, files)
  if (stage === 'unit') return evidenceInputDigest(inputs, files.filter(file => file.endsWith('.spec.ts')))
  if (stage === 'build' || stage === 'admin-build') return evidenceInputDigest(inputs, [])
  throw new Error(`unknown fast-check stage: ${stage}`)
}

/** Execution settings that can change a daily check without changing tracked files. */
export function fastCheckConfigurationDigest({ nodeVersion, platform, arch, maxWorkers }) {
  if (![nodeVersion, platform, arch, maxWorkers].every(value => typeof value === 'string' && value !== '')) {
    throw new Error('missing fast-check execution setting')
  }
  return createHash('sha256').update(JSON.stringify([nodeVersion, platform, arch, maxWorkers])).digest('hex')
}

/** Bind every executable input; no historical release inventories or allowlisted tests. */
export function evidenceFileGroups(paths) {
  const groups = { product: [], runner: [], sharedTests: [], unitTests: [], e2eTests: [] }
  for (const path of paths) {
    if (path.startsWith('docs/') || (path.endsWith('.md') && !path.includes('/'))) continue
    if (path.startsWith('tests/')) {
      if (path.endsWith('.e2e.ts')) groups.e2eTests.push(path)
      else if (path.endsWith('.spec.ts')) groups.unitTests.push(path)
      else groups.sharedTests.push(path)
    } else if (path.startsWith('scripts/')) groups.runner.push(path)
    else groups.product.push(path)
  }
  for (const group of Object.values(groups)) group.sort()
  return groups
}

/** Bind every tracked non-document input to its Git content and executable mode. */
export function evidenceIndexInputs(entries) {
  const byPath = new Map()
  for (const entry of entries) {
    if (byPath.has(entry.path)) throw new Error(`duplicate evidence input: ${entry.path}`)
    if (!/^(?:100644|100755|120000)$/u.test(entry.mode)
      || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(entry.oid)) {
      throw new Error(`invalid tracked evidence input: ${entry.path}`)
    }
    byPath.set(entry.path, [entry.path, entry.mode, entry.oid])
  }
  const digest = paths => createHash('sha256').update(JSON.stringify(paths.map(path => byPath.get(path)))).digest('hex')
  const groups = evidenceFileGroups([...byPath.keys()])
  const tests = Object.fromEntries([...groups.unitTests, ...groups.e2eTests].map(path => [path, digest([path])]))
  return {
    productDigest: digest(groups.product), runnerDigest: digest(groups.runner),
    sharedTestDigest: digest(groups.sharedTests), tests,
  }
}
