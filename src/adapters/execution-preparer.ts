import { createHash } from 'node:crypto'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { ExecutionConfiguration, ExecutionOwner } from '../domain/platform-execution.js'
import { ExecutionPreparationFailure, type PreparedExecution } from '../domain/execution-preparation.js'
import type { ExecutionPreparerPort } from '../ports/execution-preparation.js'
import { FileExecutionArtifacts } from './execution-artifacts.js'
import { ContainerExecutionProcess } from './execution-container-process.js'
import { executionSkillMount } from './execution-runner.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'

/** Preparation never mounts member files; credential-bearing logs and dependencies remain private. */
export class ContainerExecutionPreparer implements ExecutionPreparerPort {
  private image = ''
  constructor(private readonly runtime: CommunityRuntimeConfig, private readonly process: ContainerExecutionProcess,
    private readonly sources: { directory(version: string): string }, private readonly artifacts: FileExecutionArtifacts) {}
  collect(retained: readonly string[]): Promise<void> { return this.artifacts.collect(retained) }
  identity(owner: ExecutionOwner, configuration: ExecutionConfiguration): string {
    return createHash('sha256').update(JSON.stringify([owner.version, configuration.prepare ?? '', configuration.variables, this.image || this.runtime.container?.image])).digest('hex')
  }
  async recover(): Promise<void> {
    await this.process.recover()
    if (this.runtime.container) {
      const image = (await execFileText(this.runtime.container.runtime, ['image', 'inspect', '--format', '{{.Id}}', this.runtime.container.image], { env: containerClientEnvironment(), timeout: 30_000 })).trim()
      if (!/^(?:sha256:)?[a-f0-9]{64}$/u.test(image)) throw new Error('Invalid execution runtime identity')
      this.image = image
    }
  }
  async prepare(owner: ExecutionOwner, configuration: ExecutionConfiguration, signal: AbortSignal): Promise<PreparedExecution> {
    const stage = await this.artifacts.stage(), output: Buffer[] = []; let length = 0
    const log = () => {
      let value = Buffer.concat(output).toString('utf8')
      for (const row of configuration.variables) if (row.secret && row.value) value = value.replaceAll(row.value, '[redacted]')
      return value
    }
    try {
      await this.artifacts.seed(stage, this.sources.directory(owner.version)); signal.throwIfAborted()
      if (configuration.prepare) {
        const result = await this.process.run({ mounts: [{ host: stage.directory, mounted: executionSkillMount }], cwd: executionSkillMount,
          command: '/bin/sh', argv: ['-c', configuration.prepare], stdin: new Uint8Array(), timeoutMs: 600_000,
          environment: { ...Object.fromEntries(configuration.variables.map(row => [row.name, row.value])), HOME: '/tmp/phalanx-home', TMPDIR: '/tmp', PYTHONNOUSERSITE: '1',
            PATH: `${executionSkillMount}/.venv/bin:${executionSkillMount}/node_modules/.bin:${executionSkillMount}/bin:/usr/local/bin:/usr/bin:/bin` } },
        async event => { if (length < 256 * 1024) { const chunk = Buffer.from(event.data).subarray(0, 256 * 1024 - length); output.push(chunk); length += chunk.length } }, signal)
        if (result !== 0) throw new ExecutionPreparationFailure(log() + `\nPreparation exited with code ${result}.`)
      }
      signal.throwIfAborted()
      return await this.artifacts.publish(stage, owner.version, this.identity(owner, configuration), log())
    } catch (error) {
      if (error instanceof ExecutionPreparationFailure || signal.aborted) throw error
      throw new ExecutionPreparationFailure(log() + '\nPreparation could not finish.')
    } finally { if (this.process.canDiscardArtifacts) await this.artifacts.discard(stage) }
  }
}
