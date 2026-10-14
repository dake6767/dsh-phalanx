export interface ExecutionSuggestions { readonly commands: readonly string[], readonly variables: readonly string[], readonly prepare?: string }

const commandName = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u
const shellBuiltins = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'export', 'local', 'readonly', 'return', 'exit', 'echo', 'printf', 'read', 'test', 'cd', 'set', 'unset', 'source'])

/** Pure static suggestions shared by administrator inspection and contribution checks. */
export function executionSuggestions(files: ReadonlyMap<string, string>): ExecutionSuggestions {
    const commands = new Set<string>(), variables = new Set<string>()
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
