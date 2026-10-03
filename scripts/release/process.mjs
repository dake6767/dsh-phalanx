import { execFileSync } from 'node:child_process'

export function run(command, args, options = {}) {
  const result = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options })
  return typeof result === 'string' ? result.trim() : result
}
export function api(path, args = []) {
  return JSON.parse(run('gh', ['api', path, ...args]))
}
