import { createHash } from 'node:crypto'
import { relative } from 'node:path'

export const FAST_CHECK_BUDGET_MS = 10 * 60 * 1000
export const LOW_MEMORY_THRESHOLD_BYTES = 16 * 2 ** 30

function parsePositiveWorkerCount(value, label) {
  if (typeof value !== 'string') throw new Error(`invalid ${label}: ${String(value)}`)
  const trimmed = value.trim()
  if (!/^[1-9]\d*$/u.test(trimmed)) throw new Error(`invalid ${label}: ${value}`)
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`invalid ${label}: ${value}`)
  return String(parsed)
}

/** Resolve effective unit-test worker count; <=16 GiB hosts default to 2 to avoid swap pressure. */
export function resolveValidationMaxWorkers(envValue, totalMemoryBytes) {
  if (typeof totalMemoryBytes !== 'number' || !Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    throw new Error(`invalid totalMemoryBytes: ${String(totalMemoryBytes)}`)
  }
  if (envValue !== undefined && envValue !== '') {
    return parsePositiveWorkerCount(envValue, 'DSH_PHALANX_VALIDATION_MAX_WORKERS')
  }
  if (totalMemoryBytes <= LOW_MEMORY_THRESHOLD_BYTES) {
    return '2'
  }
  return 'default'
}

/** Resolve effective local controlled-browser worker count; defaults to 2 isolated workers. */
export function resolveBrowserMaxWorkers(envValue) {
  if (envValue !== undefined && envValue !== '') {
    return parsePositiveWorkerCount(envValue, 'DSH_PHALANX_VALIDATION_BROWSER_MAX_WORKERS')
  }
  return '2'
}

/** Verify a Vitest JSON report covers every expected file cleanly before caching pass evidence. */
export function verifyBrowserReportCompleteness(report, expectedFiles, root) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    return { complete: false, reason: 'missing testResults in browser report' }
  }
  if (report.success !== true) return { complete: false, reason: 'browser report success is not true' }
  if ((report.numRuntimeErrorTestSuites ?? 0) > 0) {
    return { complete: false, reason: `browser report recorded ${report.numRuntimeErrorTestSuites} runtime error suite(s)` }
  }
  const byFile = new Map()
  for (const entry of report.testResults) {
    if (!entry || typeof entry.name !== 'string') return { complete: false, reason: 'browser report contains unnamed test suite' }
    const normalized = relative(root, entry.name).replaceAll('\\', '/')
    byFile.set(normalized, entry)
    if (entry.status !== 'passed') return { complete: false, reason: `browser suite did not pass: ${normalized}` }
  }
  for (const expected of expectedFiles) {
    const normalized = expected.replaceAll('\\', '/')
    if (!byFile.has(normalized)) return { complete: false, reason: `browser report missing expected file: ${normalized}` }
  }
  return { complete: true }
}

/** A file-scoped evidence key; unrelated tests and documentation never enter it. */
export function evidenceInputDigest(inputs, files) {
  const shared = [inputs.productDigest, inputs.imageId, inputs.runnerDigest, inputs.configDigest, inputs.sharedTestDigest]
  if (shared.some(value => typeof value !== 'string' || value === '')) throw new Error('missing shared evidence input')
  const tests = [...new Set(files)].sort().map(file => {
    const digest = inputs.tests?.[file]
    if (typeof digest !== 'string' || digest === '') throw new Error(`missing test evidence input: ${file}`)
    return [file, digest]
  })
  return createHash('sha256')
    .update(JSON.stringify([shared, tests]))
    .digest('hex')
}

/** Typecheck and lint compile/inspect real-seam files too. */
export function fastCheckEvidenceDigest(inputs) {
  return evidenceInputDigest(inputs, Object.keys(inputs.tests ?? {}))
}

/** Reuse a passed stage without re-running unrelated work. */
export function fastCheckStageDigest(inputs, stage) {
  const files = Object.keys(inputs.tests ?? {})
  if (stage === 'typecheck' || stage === 'lint') return evidenceInputDigest(inputs, files)
  if (stage === 'unit')
    return evidenceInputDigest(
      inputs,
      files.filter(file => file.endsWith('.spec.ts')),
    )
  if (stage === 'build' || stage === 'admin-build') return evidenceInputDigest(inputs, [])
  throw new Error(`unknown fast-check stage: ${stage}`)
}

/** Execution settings that can change a daily check without changing tracked files. */
export function fastCheckConfigurationDigest({ nodeVersion, platform, arch, maxWorkers }) {
  if (![nodeVersion, platform, arch, maxWorkers].every(value => typeof value === 'string' && value !== '')) {
    throw new Error('missing fast-check execution setting')
  }
  return createHash('sha256')
    .update(JSON.stringify([nodeVersion, platform, arch, maxWorkers]))
    .digest('hex')
}

/** Bind every executable input; no historical release inventories or allowlisted tests. */
export function evidenceFileGroups(paths) {
  const groups = { product: [], runner: [], sharedTests: [], unitTests: [], e2eTests: [] }
  for (const path of paths) {
    if (
      path.startsWith('docs/') ||
      (path.endsWith('.md') && !path.includes('/')) ||
      /^releases\/notes\/[^/]+\.md$/u.test(path) ||
      path.startsWith('releases/acceptance/')
    )
      continue
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
    if (!/^(?:100644|100755|120000)$/u.test(entry.mode) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(entry.oid)) {
      throw new Error(`invalid tracked evidence input: ${entry.path}`)
    }
    byPath.set(entry.path, [entry.path, entry.mode, entry.oid])
  }
  const digest = paths =>
    createHash('sha256')
      .update(JSON.stringify(paths.map(path => byPath.get(path))))
      .digest('hex')
  const groups = evidenceFileGroups([...byPath.keys()])
  const tests = Object.fromEntries([...groups.unitTests, ...groups.e2eTests].map(path => [path, digest([path])]))
  return {
    productDigest: digest(groups.product),
    runnerDigest: digest(groups.runner),
    sharedTestDigest: digest(groups.sharedTests),
    tests,
  }
}
