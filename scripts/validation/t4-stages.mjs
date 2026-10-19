// T4 stage classifier: which T4 stages a diff between the tested source commit
// and a new commit requires. It decides and reports; it never schedules or
// skips a stage itself.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { matchesGlob, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Dotted paths of changed leaves; arrays and type changes count as one leaf, a missing side as the root ''. */
export function changedFields(before, after, prefix = '') {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!object(before) || !object(after)) return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix]
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .flatMap(key => changedFields(before[key], after[key], prefix ? `${prefix}.${key}` : key))
}

const within = (field, prefix) => prefix === '' || field === prefix || field.startsWith(`${prefix}.`)

/** A pattern is a path glob, optionally `file#prefix` (a field under prefix) or `file#!prefix` (a field outside it). */
function matches(change, pattern) {
  const [glob, field] = pattern.split('#')
  if (!matchesGlob(change.path, glob)) return false
  if (field === undefined) return true
  // An added or removed field file has fields [''], which every field pattern matches.
  const fields = change.fields ?? ['']
  if (field.startsWith('!')) return fields.some(changed => changed === '' || !within(changed, field.slice(1)))
  return fields.some(changed => changed === '' || within(changed, field) || within(field, changed))
}

/**
 * @param changes [{ path, fields? }] where fields lists changed dotted JSON paths for table.fieldFiles.
 * @param closures { [stageId]: tracked test files the stage's entries reference }; harness outside them triggers nothing.
 */
export function classifyStages(changes, table, closures = {}) {
  const unlisted = [], classified = []
  const stages = table.stages.map(stage => ({ id: stage.id, title: stage.title, always: stage.always === true, run: stage.always === true, reasons: [] }))
  const add = (stage, reason) => { stage.run = true; stage.reasons.push(reason) }
  for (const change of changes) {
    const record = kind => classified.push({ path: change.path, ...(change.fields ? { fields: change.fields } : {}), kind })
    // Version metadata changes every release and alone triggers no stage.
    const metadata = table.versionMetadata.map(pattern => pattern.split('#')).filter(([path]) => path === change.path).map(([, field]) => field)
    const fields = table.fieldFiles.includes(change.path)
      ? (change.fields ?? ['']).filter(field => !metadata.some(prefix => field !== '' && within(field, prefix)))
      : undefined
    if (fields?.length === 0) { record('versionMetadata'); continue }
    const effective = fields === undefined ? change : { path: change.path, fields }
    const reason = (kind, pattern) => ({ path: change.path, kind, ...(pattern ? { pattern } : {}), ...(fields ? { fields } : {}) })
    if (table.harness.some(glob => matchesGlob(change.path, glob))) {
      const users = table.sharedHarness.includes(change.path) ? stages : stages.filter(stage => closures[stage.id]?.includes(change.path))
      for (const stage of users) add(stage, reason('harness'))
      record(users.length ? 'harness' : 'harnessUnused')
      continue
    }
    if (table.noStage.some(glob => matchesGlob(change.path, glob))) { record('noStage'); continue }
    const all = table.allStages.find(pattern => matches(effective, pattern))
    if (all !== undefined) {
      for (const stage of stages) add(stage, reason('buildInput', all))
      record('buildInput')
      continue
    }
    let listed = false
    for (const [index, stage] of table.stages.entries()) {
      const pattern = stage.paths.find(candidate => matches(effective, candidate))
      if (pattern === undefined) continue
      listed = true
      add(stages[index], reason('deliverable', pattern))
    }
    if (listed) { record('deliverable'); continue }
    unlisted.push(change.path)
    for (const stage of stages) add(stage, reason('unlisted'))
    record('unlisted')
  }
  return { unlisted, changes: classified, stages }
}

const git = (args, root, encoding = 'utf8') => {
  const result = spawnSync('git', args, { cwd: root, encoding, maxBuffer: 256 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr).trim()}`)
  return result.stdout
}

// Stages share entries and support files; read each commit's sources once, in one git process.
const sources = new Map()
function treeSources(commit, root) {
  const key = `${root}\0${commit}`
  if (sources.has(key)) return sources.get(key)
  const blobs = git(['ls-tree', '-r', '-z', '--full-tree', commit], root).split('\0').filter(Boolean).flatMap(line => {
    const match = /^\d+ blob ([a-f0-9]+)\t(.+)$/su.exec(line)
    return match ? [{ oid: match[1], path: match[2] }] : []
  })
  const scripts = blobs.filter(blob => /\.(c|m)?(j|t)sx?$/u.test(blob.path))
  const output = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: scripts.map(blob => `${blob.oid}\n`).join(''), maxBuffer: 256 * 1024 * 1024 })
  if (output.status !== 0) throw new Error(`git cat-file failed: ${output.stderr}`)
  const texts = new Map()
  let offset = 0
  for (const blob of scripts) {
    const header = output.stdout.subarray(offset, output.stdout.indexOf(10, offset)).toString()
    const size = Number(/ blob (\d+)$/u.exec(header)?.[1])
    if (!Number.isSafeInteger(size)) throw new Error(`Unexpected git cat-file header for ${blob.path}: ${header}`)
    offset += header.length + 1
    texts.set(blob.path, output.stdout.subarray(offset, offset + size).toString('utf8'))
    offset += size + 1
  }
  const result = { tracked: new Set(blobs.map(blob => blob.path)), texts }
  sources.set(key, result)
  return result
}

// Static and dynamic imports, re-exports and files located with `new URL(path, import.meta.url)`.
const REFERENCES = /(?:\bfrom\s*|\bimport\s*\(?\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/gu
const SOURCE_NAMES = target => [target, ...[['.js', ['.ts', '.tsx']], ['.mjs', ['.mts']], ['.cjs', ['.cts']], ['.jsx', ['.tsx']]]
  .flatMap(([from, to]) => target.endsWith(from) ? to.map(extension => target.slice(0, -from.length) + extension) : [])]

/** Tracked files referenced (relative specifiers only) from the entries at `commit`, entries included. */
export function importClosure(entries, commit, root = '.') {
  const { tracked, texts } = treeSources(commit, root)
  const seen = new Set(), queue = [...entries]
  while (queue.length) {
    const file = queue.shift()
    if (seen.has(file) || !tracked.has(file)) continue
    seen.add(file)
    for (const [, specifier] of (texts.get(file) ?? '').matchAll(REFERENCES)) {
      queue.push(...SOURCE_NAMES(posix.normalize(posix.join(posix.dirname(file), specifier))).filter(name => tracked.has(name)))
    }
  }
  return [...seen].sort()
}

export function diffChanges(base, head, table, root = '.') {
  const show = (commit, path) => {
    const result = spawnSync('git', ['show', `${commit}:${path}`], { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) return undefined
    try { return JSON.parse(result.stdout) } catch { return { invalid: result.stdout } }
  }
  return git(['diff', '--name-only', '--no-renames', '-z', base, head], root).split('\0').filter(Boolean).map(path =>
    table.fieldFiles.includes(path) ? { path, fields: changedFields(show(base, path), show(head, path)) } : { path })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), harnessRefs = {}
  for (let index = args.indexOf('--harness-base'); index !== -1; index = args.indexOf('--harness-base')) {
    const [value] = args.splice(index, 2).slice(1)
    const [stage, ref] = value?.includes('=') ? value.split('=') : ['*', value]
    if (!ref) throw new Error('--harness-base needs COMMIT or STAGE=COMMIT')
    harnessRefs[stage] = ref
  }
  if (args.length !== 2) throw new Error('Usage: node scripts/validation/t4-stages.mjs TESTED_SOURCE_COMMIT NEW_COMMIT [--harness-base [STAGE=]TESTED_HARNESS_COMMIT ...]')
  const root = git(['rev-parse', '--show-toplevel']).trim()
  const commit = ref => git(['rev-parse', '--verify', `${ref}^{commit}`], root).trim()
  const [base, head] = args.map(commit)
  const table = JSON.parse(readFileSync(new URL('./t4-stages.json', import.meta.url), 'utf8'))
  const unknown = Object.keys(harnessRefs).filter(stage => stage !== '*' && !table.stages.some(row => row.id === stage))
  if (unknown.length) throw new Error(`Unknown T4 stage for --harness-base: ${unknown.join(', ')}`)
  const harnessBases = Object.fromEntries(table.stages.map(stage => [stage.id, commit(harnessRefs[stage.id] ?? harnessRefs['*'] ?? base)]))
  const isHarness = change => table.harness.some(glob => matchesGlob(change.path, glob))
  // Deliverable bytes compare with the tested source; each stage's harness with the harness that stage actually ran.
  const results = [...new Set(Object.values(harnessBases))].map(harnessBase => {
    const closures = Object.fromEntries(table.stages.filter(stage => harnessBases[stage.id] === harnessBase).map(stage => [stage.id,
      [...new Set([...importClosure(stage.entries, harnessBase, root), ...importClosure(stage.entries, head, root)])]]))
    const changes = [...diffChanges(base, head, table, root).filter(change => !isHarness(change)),
      ...diffChanges(harnessBase, head, table, root).filter(isHarness)]
    return { harnessBase, closures, result: classifyStages(changes, table, closures) }
  })
  const stages = table.stages.map(stage => ({ ...results.find(row => stage.id in row.closures).result.stages.find(row => row.id === stage.id), harnessBase: harnessBases[stage.id] }))
  const unlisted = [...new Set(results.flatMap(row => row.result.unlisted))]
  const changes = results.flatMap(row => row.result.changes.map(change => ({ ...change, ...(change.kind.startsWith('harness') ? { harnessBase: row.harnessBase } : {}) })))
    .filter((change, index, rows) => !change.kind.startsWith('harness') ? rows.findIndex(other => other.path === change.path && !other.kind.startsWith('harness')) === index : true)
  console.log(JSON.stringify({ schema: 1, base, head, harnessBases, unlisted, changes, stages }, null, 2))
  console.error(`T4 stages ${base.slice(0, 7)}..${head.slice(0, 7)}: run ${stages.filter(stage => stage.run).map(stage => stage.id).join(', ')}; ` +
    `reuse ${stages.filter(stage => !stage.run).map(stage => stage.id).join(', ') || 'none'}` +
    (unlisted.length ? `; ${unlisted.length} unlisted path(s) conservatively trigger every stage` : ''))
}
