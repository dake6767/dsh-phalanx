import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { effectiveUserDataRoot } from '../domain/storage-layout.js'
import { ExecutionFailure } from '../domain/platform-execution.js'

export const runtimeDependencyMount = '/dsh-phalanx/runtime-dependencies/.trees'
type Mount = { readonly host: string; readonly mounted: string; readonly readOnly?: boolean }
const inside = (root: string, path: string) => {
  const part = relative(root, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith('../')
}

/** Only private artifact staging and the read-only bootstrap can carry this preparation identity. */
export async function validateRuntimePreparationMounts(
  runtime: CommunityRuntimeConfig,
  input: { readonly cwd: string; readonly mounts: readonly Mount[] },
): Promise<void> {
  const reject = () => {
    throw new ExecutionFailure('invalid-directory')
  }
  if (input.mounts.length !== 2) reject()
  const stage = input.mounts.find(row => row.mounted.startsWith(runtimeDependencyMount + '/'))
  const runner = input.mounts.find(row => row.mounted === '/dsh-phalanx/execution-runner')
  if (!stage || !runner) return reject()
  const id = basename(stage.host),
    root = resolve(runtime.dataRoot),
    runnerRoot = join(root, 'execution/runner')
  if (
    !/^[a-f0-9]{64}$/u.test(id) ||
    basename(dirname(stage.host)) !== '.trees' ||
    stage.mounted !== runtimeDependencyMount + '/' + id ||
    input.cwd !== stage.mounted ||
    !inside(root, resolve(stage.host)) ||
    resolve(runner.host) !== runnerRoot ||
    runner.readOnly !== true
  )
    reject()
  const canonicalRoot = await realpath(root)
  const canonicalStage = await realpath(stage.host)
  const canonicalRunner = await realpath(runner.host)
  if (canonicalStage !== join(canonicalRoot, relative(root, resolve(stage.host))) || canonicalRunner !== join(canonicalRoot, 'execution/runner')) reject()
  const users = effectiveUserDataRoot(runtime)
  const canonicalUsers = await canonicalFutureDirectory(users)
  for (const path of [canonicalStage, canonicalRunner]) if (inside(canonicalUsers, path) || inside(path, canonicalUsers)) reject()
}

async function canonicalFutureDirectory(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error
    return join(await canonicalFutureDirectory(dirname(path)), basename(path))
  }
}
