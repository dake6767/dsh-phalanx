import { platformSystemPath } from './platform-process-host.js'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { ExecutionFailure } from '../domain/platform-execution.js'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { CommunityUserSpaceStoragePort } from '../ports/community-user-spaces.js'
import type { ExecutionRunnerPort } from '../ports/platform-execution.js'
import { DSH_CONTAINER_HOME } from '../dsh/profile-layout.js'
import { ContainerExecutionProcess } from './execution-container-process.js'
import { FilePythonLibraryEnvironments } from './python-library-environment.js'

export const executionSkillMount = '/dsh-phalanx/execution-skill'
const skillMount = executionSkillMount, workspaceMount = '/dsh-phalanx/workspace'
const inside = (root: string, path: string) => { const part = relative(root, path); return part === '' || (!part.startsWith('..') && !isAbsolute(part)) }

/** Resolve the member's working directory and trusted skill before invoking the container. */
export class ContainerExecutionRunner implements ExecutionRunnerPort {
  private readonly process: ContainerExecutionProcess
  private readonly pythonEnvironments: FilePythonLibraryEnvironments
  constructor(private readonly runtime: CommunityRuntimeConfig, private readonly spaces: CommunityUserSpaceStoragePort,
    private readonly sources: { directory(version: string): string }, process?: ContainerExecutionProcess,
    private readonly prepared?: { directory(id: string): string }) {
    this.process = process ?? new ContainerExecutionProcess(runtime)
    this.pythonEnvironments = new FilePythonLibraryEnvironments(join(runtime.dataRoot, 'execution/python-libraries'), () => this.process.canDiscardArtifacts)
  }
  async recover(): Promise<void> { await this.process.recover(); await this.pythonEnvironments.collect() }
  async stop(): Promise<void> { await this.process.stop(); await this.pythonEnvironments.collect() }
  async run(input: Parameters<ExecutionRunnerPort['run']>[0], emit: Parameters<ExecutionRunnerPort['run']>[1], signal: AbortSignal): Promise<number> {
    const space = await this.spaces.prepare(input.username)
    const mounts = [{ host: space.home, mounted: this.runtime.container ? DSH_CONTAINER_HOME : space.home }, { host: space.workspace, mounted: this.runtime.container ? workspaceMount : space.workspace }]
    const mount = mounts.find(row => isAbsolute(input.cwd) && inside(row.mounted, resolve(input.cwd)))
    if (!mount) throw new ExecutionFailure('invalid-directory')
    const hostCwd = resolve(mount.host, relative(mount.mounted, resolve(input.cwd)))
    try { if (!inside(await realpath(mount.host), await realpath(hostCwd)) || !(await stat(hostCwd)).isDirectory()) throw new Error() }
    catch { throw new ExecutionFailure('invalid-directory') }
    const source = input.sourceDependency?.directory ?? (input.artifact && this.prepared ? this.prepared.directory(input.artifact) : this.sources.directory(input.version))
    const sourceMount = input.sourceDependency?.mountedPath ?? skillMount
    let command = input.command, argv = [...input.argv], pythonScript: string | undefined
    if (command.includes('/')) {
      const sourceCommand = resolve(source, command)
      try { if (!inside(source, sourceCommand) || !inside(await realpath(source), await realpath(sourceCommand)) || !(await stat(sourceCommand)).isFile()) throw new Error() }
      catch { throw new ExecutionFailure('command-missing') }
      command = join(sourceMount, command)
      const script = await readFile(sourceCommand)
      if (command.endsWith('.py')) { pythonScript = command; command = 'python3' }
      else if (!script.subarray(0, 2).equals(Buffer.from('#!'))) {
        const interpreter = command.endsWith('.py') ? 'python3' : /\.[cm]?js$/u.test(command) ? 'node' : command.endsWith('.sh') ? '/bin/sh' : undefined
        if (!interpreter) throw new ExecutionFailure('command-missing')
        argv = [command, ...argv]; command = interpreter
      }
    }
    const dependencies = input.dependencies ?? []
    return this.pythonEnvironments.withEnvironment(dependencies, Boolean(this.runtime.container), python =>
      this.process.run({ mounts: [...mounts, ...(python ? [python] : []), ...(input.sourceDependency ? [] : [{ host: source, mounted: skillMount, readOnly: true }]), ...dependencies.map(row => ({ host: row.directory, mounted: row.mountedPath, readOnly: true }))], cwd: resolve(input.cwd), command, argv, ...(pythonScript ? { pythonScript } : {}),
        stdin: input.stdin, environment: { ...input.environment, HOME: '/tmp/phalanx-home', PYTHONNOUSERSITE: '1',
          PATH: platformSystemPath([...(python ? [python.mounted] : []), ...dependencies.filter(row => !row.python).flatMap(row => row.pathDirectories.map(path => `${row.mountedPath}/${path}`)), ...(input.artifact ? [`${skillMount}/.venv/bin`, `${skillMount}/node_modules/.bin`] : []), `${skillMount}/bin`, skillMount]), TMPDIR: '/tmp' } }, emit, signal))
  }
}
