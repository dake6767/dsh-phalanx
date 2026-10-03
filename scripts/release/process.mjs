import { execFileSync, spawnSync } from 'node:child_process'

export function run(command, args, options = {}) {
  const result = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options })
  return typeof result === 'string' ? result.trim() : result
}
export function probe(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return { ok: result.status === 0, output: result.stdout.trim(), error: result.stderr.trim() }
}
export function api(path, args = []) {
  return JSON.parse(run('gh', ['api', path, ...args]))
}
