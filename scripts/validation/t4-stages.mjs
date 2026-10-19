// T4 stage classifier (ADR 0023): which T4 stages a diff between the tested
// source commit and a new commit requires. It decides and reports; it never
// schedules or skips a stage itself.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, matchesGlob, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Dotted paths of changed leaves; arrays and type changes count as one leaf, a missing side as the root ''. */
export function changedFields(before, after, prefix = '') {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!object(before) || !object(after)) return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix]
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .flatMap(key => changedFields(before[key], after[key], prefix ? `${prefix}.${key}` : key))
}

const within = (field, prefix) => prefix === '' || field === prefix || field.startsWith(`${prefix}.`)

/** A pattern is a path glob, optionally `file#field.prefix` for a field-tracked JSON file. */
function matches(change, pattern) {
  const [glob, field] = pattern.split('#')
  if (!matchesGlob(change.path, glob)) return false
  if (field === undefined) return true
  // An unparsed or added/removed file has fields [''], which every field prefix matches.
  return (change.fields ?? ['']).some(changed => changed === '' || within(changed, field) || within(field, changed))
}

/**
 * @param changes [{ path, fields? }] where fields lists changed dotted JSON paths for table.fieldFiles.
 * @param closures { [stageId]: tracked test files the stage's entries import }; harness outside them triggers nothing.
 */
export function classifyStages(changes, table, closures = {}) {
  const unlisted = [], stages = table.stages.map(stage => ({ id: stage.id, title: stage.title, always: stage.always === true, run: stage.always === true, reasons: [] }))
  const add = (stage, reason) => { stage.run = true; stage.reasons.push(reason) }
  for (const change of changes) {
    // Version metadata changes every release and alone triggers no stage.
    const metadata = table.versionMetadata.map(pattern => pattern.split('#')).filter(([path]) => path === change.path).map(([, field]) => field)
    const fields = table.fieldFiles.includes(change.path)
      ? (change.fields ?? ['']).filter(field => !metadata.some(prefix => field !== '' && within(field, prefix)))
      : undefined
    if (fields?.length === 0) continue
    const effective = fields === undefined ? change : { path: change.path, fields }
    if (table.harness.some(glob => matchesGlob(change.path, glob))) {
      for (const stage of stages) if (closures[stage.id]?.includes(change.path)) add(stage, { path: change.path, kind: 'harness' })
      continue
    }
    if (table.noStage.some(glob => matchesGlob(change.path, glob))) continue
    let listed = false
    for (const [index, stage] of table.stages.entries()) {
      const pattern = stage.paths.find(candidate => matches(effective, candidate))
      if (pattern === undefined) continue
      listed = true
      add(stages[index], { path: change.path, kind: 'deliverable', pattern, ...(fields ? { fields } : {}) })
    }
    if (!listed) {
      unlisted.push(change.path)
      for (const stage of stages) add(stage, { path: change.path, kind: 'unlisted' })
    }
  }
  return { unlisted, stages }
}

const git = (args, root) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout
}

// Stages share entries and support files; read each commit's sources once, in one git process.
const sources = new Map()
function scriptSources(commit, root) {
  const key = `${root}\0${commit}`
  if (sources.has(key)) return sources.get(key)
  const files = git(['ls-tree', '-r', '--name-only', '-z', commit], root).split('\0').filter(Boolean)
  const scripts = files.filter(file => /\.(ts|mts|mjs|js)$/u.test(file))
  const batch = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: scripts.map(file => `${commit}:${file}\n`).join(''), maxBuffer: 256 * 1024 * 1024 })
  if (batch.status !== 0) throw new Error(`git cat-file failed: ${batch.stderr}`)
  const texts = new Map(), output = batch.stdout
  let offset = 0
  for (const file of scripts) {
    const header = output.subarray(offset, output.indexOf(10, offset)).toString()
    const size = Number(/ blob (\d+)$/u.exec(header)?.[1])
    if (!Number.isSafeInteger(size)) throw new Error(`Unexpected git cat-file header for ${file}: ${header}`)
    offset += header.length + 1
    texts.set(file, output.subarray(offset, offset + size).toString('utf8'))
    offset += size + 1
  }
  const result = { tracked: new Set(files), texts }
  sources.set(key, result)
  return result
}

/** Tracked files statically imported (relative specifiers only) from the entries at `commit`, entries included. */
export function importClosure(entries, commit, root = '.') {
  const { tracked, texts } = scriptSources(commit, root)
  const seen = new Set(), queue = [...entries]
  while (queue.length) {
    const file = queue.shift()
    if (seen.has(file) || !tracked.has(file)) continue
    seen.add(file)
    const text = texts.get(file)
    if (text === undefined) continue
    for (const [, specifier] of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/gu)) {
      const target = normalize(join(dirname(file), specifier))
      // TypeScript sources import their compiled `.js` name.
      queue.push(...[target, target.replace(/\.js$/u, '.ts'), target.replace(/\.mjs$/u, '.mts')].filter(name => tracked.has(name)))
    }
  }
  return [...seen].sort()
}

export function diffChanges(base, head, table, root = '.') {
  const show = (commit, path) => {
    const result = spawnSync('git', ['show', `${commit}:${path}`], { cwd: root, encoding: 'utf8' })
    return result.status === 0 ? JSON.parse(result.stdout) : undefined
  }
  return git(['diff', '--name-only', '--no-renames', '-z', base, head], root).split('\0').filter(Boolean).map(path =>
    table.fieldFiles.includes(path) ? { path, fields: changedFields(show(base, path), show(head, path)) } : { path })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), at = args.indexOf('--harness-base')
  const harnessRef = at === -1 ? undefined : args.splice(at, 2)[1]
  if (args.length !== 2 || (at !== -1 && !harnessRef)) throw new Error('Usage: node scripts/validation/t4-stages.mjs TESTED_SOURCE_COMMIT NEW_COMMIT [--harness-base TESTED_HARNESS_COMMIT]')
  const commit = ref => git(['rev-parse', '--verify', `${ref}^{commit}`]).trim()
  const [base, head] = args.map(commit), harnessBase = harnessRef ? commit(harnessRef) : base
  const table = JSON.parse(readFileSync(new URL('./t4-stages.json', import.meta.url), 'utf8'))
  const isHarness = change => table.harness.some(glob => matchesGlob(change.path, glob))
  // Harness changes count against the stage harness at either commit.
  const closures = Object.fromEntries(table.stages.map(stage => [stage.id,
    [...new Set([...importClosure(stage.entries, harnessBase), ...importClosure(stage.entries, head)])]]))
  // Deliverable bytes compare with the tested source; harness with the harness that actually ran.
  const changes = [...diffChanges(base, head, table).filter(change => !isHarness(change)),
    ...diffChanges(harnessBase, head, table).filter(isHarness)]
  const result = classifyStages(changes, table, closures)
  console.log(JSON.stringify({ schema: 1, base, head, harnessBase, changedPaths: changes.length, ...result }, null, 2))
  console.error(`T4 stages ${base.slice(0, 7)}..${head.slice(0, 7)}: run ${result.stages.filter(stage => stage.run).map(stage => stage.id).join(', ')}; ` +
    `reuse ${result.stages.filter(stage => !stage.run).map(stage => stage.id).join(', ') || 'none'}` +
    (result.unlisted.length ? `; ${result.unlisted.length} unlisted path(s) conservatively trigger every stage` : ''))
}
