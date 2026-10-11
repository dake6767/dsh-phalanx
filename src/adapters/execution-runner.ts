import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { ExecutionFailure } from '../domain/platform-execution.js'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { CommunityUserSpaceStoragePort } from '../ports/community-user-spaces.js'
import type { ExecutionRunnerPort } from '../ports/platform-execution.js'
import { DSH_CONTAINER_HOME } from '../dsh/profile-layout.js'
import { ContainerExecutionProcess } from './execution-container-process.js'

export const executionSkillMount = '/dsh-phalanx/execution-skill'
const skillMount = executionSkillMount, workspaceMount = '/dsh-phalanx/workspace'
const inside = (root: string, path: string) => { const part = relative(root, path); return part === '' || (!part.startsWith('..') && !isAbsolute(part)) }

/** Resolve the member's working directory and trusted skill before invoking the container. */
export class ContainerExecutionRunner implements ExecutionRunnerPort {
  private readonly process: ContainerExecutionProcess
  constructor(private readonly runtime: CommunityRuntimeConfig, private readonly spaces: CommunityUserSpaceStoragePort,
    private readonly sources: { directory(version: string): string }, process?: ContainerExecutionProcess,
    private readonly prepared?: { directory(id: string): string }) { this.process = process ?? new ContainerExecutionProcess(runtime) }
  recover(): Promise<void> { return this.process.recover() }
  stop(): Promise<void> { return this.process.stop() }
  async run(input: Parameters<ExecutionRunnerPort['run']>[0], emit: Parameters<ExecutionRunnerPort['run']>[1], signal: AbortSignal): Promise<number> {
    const space = await this.spaces.prepare(input.username)
    const mounts = [{ host: space.home, mounted: this.runtime.container ? DSH_CONTAINER_HOME : space.home }, { host: space.workspace, mounted: this.runtime.container ? workspaceMount : space.workspace }]
    const mount = mounts.find(row => isAbsolute(input.cwd) && inside(row.mounted, resolve(input.cwd)))
    if (!mount) throw new ExecutionFailure('invalid-directory')
    const hostCwd = resolve(mount.host, relative(mount.mounted, resolve(input.cwd)))
    try { if (!inside(await realpath(mount.host), await realpath(hostCwd)) || !(await stat(hostCwd)).isDirectory()) throw new Error() }
    catch { throw new ExecutionFailure('invalid-directory') }
    const source = input.artifact && this.prepared ? this.prepared.directory(input.artifact) : this.sources.directory(input.version)
    let command = input.command, argv = [...input.argv]
    if (command.includes('/')) {
      const sourceCommand = resolve(source, command)
      try { if (!inside(source, sourceCommand) || !(await stat(sourceCommand)).isFile()) throw new Error() }
      catch { throw new ExecutionFailure('command-missing') }
      command = join(skillMount, command)
      const script = await readFile(sourceCommand)
      if (!script.subarray(0, 2).equals(Buffer.from('#!'))) {
        const interpreter = command.endsWith('.py') ? 'python3' : /\.[cm]?js$/u.test(command) ? 'node' : command.endsWith('.sh') ? '/bin/sh' : undefined
        if (!interpreter) throw new ExecutionFailure('command-missing')
        argv = [command, ...argv]; command = interpreter
      }
    }
    return this.process.run({ mounts: [...mounts, { host: source, mounted: skillMount, readOnly: true }], cwd: resolve(input.cwd), command, argv,
      stdin: input.stdin, environment: { ...input.environment, HOME: '/tmp/phalanx-home', PYTHONNOUSERSITE: '1',
        PATH: `${skillMount}/.venv/bin:${skillMount}/node_modules/.bin:${skillMount}/bin:${skillMount}:/usr/local/bin:/usr/bin:/bin`, TMPDIR: '/tmp' } }, emit, signal)
  }
}
