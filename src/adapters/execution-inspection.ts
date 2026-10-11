import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExecutionInspectionPort, ExecutionSuggestions } from '../ports/execution-inspection.js'

const commandName = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u
const shellBuiltins = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'export', 'local', 'readonly', 'return', 'exit', 'echo', 'printf', 'read', 'test', 'cd', 'set', 'unset', 'source'])

/** Reads immutable skill sources only. Suggestions contain names, never credential values. */
export class FileExecutionInspection implements ExecutionInspectionPort {
  private readonly cache = new Map<string, Promise<Map<string, string>>>()
  constructor(private readonly sources: { directory(version: string): string }) {}
  async inspect(version: string): Promise<ExecutionSuggestions> {
    const files = await this.files(version), commands = new Set<string>(), variables = new Set<string>()
    for (const [path, body] of files) {
      if (!/\.(?:sh|bash|py|[cm]?js|ts)$/u.test(path) && !body.startsWith('#!')) continue
      commands.add(path.includes('/') ? path : './' + path)
      const reads = [
        /(?:os\.(?:getenv|environ\.get)\s*\(\s*|os\.environ\s*\[\s*|process\.env\s*\[\s*)["']([A-Za-z_][A-Za-z0-9_]*)["']/gu,
        /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/gu,
        /\$\{?([A-Za-z_][A-Za-z0-9_]*)/gu,
      ]
      for (const pattern of reads) for (const match of body.matchAll(pattern)) if (/KEY|TOKEN|SECRET/iu.test(match[1]!)) variables.add(match[1]!)
      for (const match of body.matchAll(/(?:subprocess\.(?:run|call|check_call|check_output|Popen)\s*\(\s*\[?\s*|(?:spawn|execFile|execSync|exec)\s*\(\s*)["']([A-Za-z0-9_.-]+)(?=["'\s])/gu)) commands.add(match[1]!)
      if (/\.(?:sh|bash)$/u.test(path) || /^#!.*\b(?:sh|bash)\b/u.test(body)) {
        for (const line of body.split('\n')) {
          const match = line.trim().match(/^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*)([A-Za-z0-9_.-]+)(?:\s|$)/u)
          if (match && commandName.test(match[1]!) && !shellBuiltins.has(match[1]!)) commands.add(match[1]!)
        }
      }
    }
    const preparation: string[] = []
    if (files.has('requirements.txt')) preparation.push('python3 -m venv .venv', '.venv/bin/pip install -r requirements.txt')
    if (files.has('setup.sh')) preparation.push('sh setup.sh')
    return { commands: [...commands].sort(), variables: [...variables].sort(), ...(preparation.length ? { prepare: preparation.join(' && ') } : {}) }
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
