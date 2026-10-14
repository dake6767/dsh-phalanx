import { platformSystemPath } from './platform-process-host.js'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { ExecutionConfiguration, ExecutionOwner } from '../domain/platform-execution.js'
import { ExecutionPreparationFailure, type PreparedExecution } from '../domain/execution-preparation.js'
import type { ExecutionPreparerPort } from '../ports/execution-preparation.js'
import { FileExecutionArtifacts } from './execution-artifacts.js'
import { ContainerExecutionProcess } from './execution-container-process.js'
import { executionSkillMount } from './execution-runner.js'

/** Preparation never mounts member files; credential-bearing logs and dependencies remain private. */
export class ContainerExecutionPreparer implements ExecutionPreparerPort {
  private image = ''
  constructor(private readonly runtime: CommunityRuntimeConfig, private readonly process: Pick<ContainerExecutionProcess, 'run' | 'recover' | 'imageIdentity' | 'canDiscardArtifacts'>,
    private readonly sources: { directory(version: string): string }, private readonly artifacts: FileExecutionArtifacts, private readonly mountFor: (directory: string) => string = () => executionSkillMount) {}
  collect(retained: readonly string[]): Promise<void> { return this.process.canDiscardArtifacts ? this.artifacts.collect(retained) : Promise.resolve() }
  identity(owner: ExecutionOwner, configuration: ExecutionConfiguration): string {
    return createHash('sha256').update(JSON.stringify([owner.version, configuration.prepare ?? '', configuration.variables, this.image || this.runtime.container?.image])).digest('hex')
  }
  async recover(): Promise<void> {
    await this.process.recover()
    this.image = await this.process.imageIdentity()
  }
  async prepare(owner: ExecutionOwner, configuration: ExecutionConfiguration, signal: AbortSignal): Promise<PreparedExecution> {
    const stage = await this.artifacts.stage(), mounted = this.mountFor(stage.directory), output: Buffer[] = []; let length = 0, published = false
    const log = () => {
      let value = Buffer.concat(output).toString('utf8')
      for (const row of configuration.variables) if (row.secret && row.value) value = value.replaceAll(row.value, '[redacted]')
      return value
    }
    try {
      await this.artifacts.seed(stage, this.sources.directory(owner.version)); signal.throwIfAborted()
      if (configuration.prepare) {
        await mkdir(join(stage.directory, '.preparation-tmp'), { mode: 0o700 })
        const result = await this.process.run({ mounts: [{ host: stage.directory, mounted }], cwd: mounted,
          command: '/bin/sh', argv: ['-c', configuration.prepare], stdin: new Uint8Array(), timeoutMs: 600_000,
          environment: { ...Object.fromEntries(configuration.variables.map(row => [row.name, row.value])), HOME: '/tmp/phalanx-home', TMPDIR: `${mounted}/.preparation-tmp`, PYTHONNOUSERSITE: '1',
            PATH: platformSystemPath([`${mounted}/.venv/bin`, `${mounted}/node_modules/.bin`, `${mounted}/bin`]) } },
        async event => { if (length < 256 * 1024) { const chunk = Buffer.from(event.data).subarray(0, 256 * 1024 - length); output.push(chunk); length += chunk.length } }, signal)
        if (result !== 0) throw new ExecutionPreparationFailure(log() + `\nPreparation exited with code ${result}.`)
      }
      signal.throwIfAborted()
      await rm(join(stage.directory, '.preparation-tmp'), { recursive: true, force: true })
      const artifact = await this.artifacts.publish(stage, owner.version, this.identity(owner, configuration), log())
      published = true; return artifact
    } catch (error) {
      if (error instanceof ExecutionPreparationFailure || signal.aborted) throw error
      throw new ExecutionPreparationFailure(log() + '\nPreparation could not finish.')
    } finally { if (!published && this.process.canDiscardArtifacts) await this.artifacts.discard(stage) }
  }
}
