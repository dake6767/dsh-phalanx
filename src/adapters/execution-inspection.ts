import { executionSuggestions } from '../domain/execution-suggestions.js'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExecutionInspectionPort, ExecutionSuggestions } from '../ports/execution-inspection.js'

/** Reads immutable skill sources only. Suggestions contain names, never credential values. */
export class FileExecutionInspection implements ExecutionInspectionPort {
  private readonly cache = new Map<string, Promise<Map<string, string>>>()
  constructor(private readonly sources: { directory(version: string): string }) {}
  async inspect(version: string): Promise<ExecutionSuggestions> {
    return executionSuggestions(await this.files(version))
  }
  async available(version: string, command: string): Promise<boolean> {
    // External commands may be installed by administrator-provided preparation; static scans cannot disprove them.
    return !command.includes('/') || (await this.files(version)).has(command.replace(/^\.\//u, ''))
  }
  private files(version: string): Promise<Map<string, string>> {
    const cached = this.cache.get(version)
    if (cached) return cached
    if (this.cache.size >= 4) this.cache.delete(this.cache.keys().next().value!)
    const loading = this.read(version).catch(error => { this.cache.delete(version); throw error })
    this.cache.set(version, loading); return loading
  }
  private async read(version: string): Promise<Map<string, string>> {
    const root = this.sources.directory(version), files = new Map<string, string>()
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(path)
        else if (entry.isFile()) {
          const content = await readFile(join(root, path))
          files.set(path, content.includes(0) ? '' : content.toString('utf8'))
        }
      }
    }
    await walk(''); return files
  }
}
