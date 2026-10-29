import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dataRootLayout } from '../domain/data-root-layout.js'

type Inventory = { [Kind in keyof typeof dataRootLayout]: string[] }

/** Checks actual populated roots without following links into durable or unrelated storage. */
export async function inspectDataRoot(root: string): Promise<Inventory> {
  const result: Inventory = { artifacts: [], projections: [], runtime: [], files: [] }
  const entries = Object.entries(dataRootLayout).flatMap(([kind, paths]) => paths.map(path => ({ kind: kind as keyof Inventory, path })))
  const walk = async (path: string): Promise<void> => {
    const info = await lstat(join(root, path))
    const entry = entries.find(row => row.path === path)
    if (info.isSymbolicLink() || (entry?.kind === 'files' ? !info.isFile() : !info.isDirectory())) throw Error(`Invalid data-root entry: ${path || '.'}`)
    if (entry) {
      result[entry.kind].push(path)
      return
    }
    if (path && !entries.some(row => row.path.startsWith(path + '/'))) throw Error(`Unexpected data-root entry: ${path}`)
    for (const child of (await readdir(join(root, path))).sort()) await walk(path ? path + '/' + child : child)
  }
  await walk('')
  return result
}
