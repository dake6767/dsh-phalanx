/**
 * Restore workspace-package links at the installation root after the
 * production prune.
 *
 * DSH's profile boot code imports workspace and vendored packages by name
 * (for example `@deepseek-ai/cordis`), and the development install makes them
 * resolvable from the installation root because the root project lists many of
 * them as devDependencies. The prune keeps only each project's production
 * dependency links, so those names would stop resolving at run time. This step
 * links every workspace package into `<root>/node_modules`, which is exactly
 * the resolution the development install provided.
 *
 * Run from the installation root: `node <this file>`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const NODE_MODULES = join(ROOT, 'node_modules')
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'lib', 'scripts', 'tests', 'fixtures'])
const MAX_DEPTH = 4

/** Every directory below ROOT that carries a package.json. */
function findProjects(directory, depth, found) {
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (existsSync(join(path, 'package.json'))) {
      found.push(path)
      continue
    }
    findProjects(path, depth + 1, found)
  }
}

const projects = []
findProjects(ROOT, 0, projects)

let linked = 0
let skipped = 0
for (const project of projects) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
  } catch {
    continue
  }
  const name = manifest.name
  if (typeof name !== 'string' || name === '' || name.includes('..')) continue
  const link = join(NODE_MODULES, name)
  if (existsSync(link)) {
    skipped += 1
    continue
  }
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(relative(dirname(link), project), link, 'dir')
  linked += 1
}

console.log(`workspace links: ${String(linked)} created, ${String(skipped)} already present`)
