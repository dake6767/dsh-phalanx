import { configurationDumpArgs } from '../dsh/cli.js'
import { buildCommunityContainerLaunchCommand } from '../dsh/container.js'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'

type ContainerInput = Parameters<typeof buildCommunityContainerLaunchCommand>[0]

/** Dump stdout may contain private member settings: consume it only in memory and never report command output. */
export async function dumpNativeConfiguration(
  input: {
    readonly config: CommunityRuntimeConfig
    readonly workspace: string
    readonly environment: Readonly<Record<string, string>>
    readonly patches: readonly string[]
    readonly container?: ContainerInput
  },
  signal: AbortSignal,
): Promise<string> {
  const plan = input.container ? buildCommunityContainerLaunchCommand({ ...input.container, mode: 'config-dump' }) : undefined
  let failure: unknown
  let output: string | undefined
  try {
    output = await execFileText(plan?.command ?? input.config.command, plan?.args ?? configurationDumpArgs(input.config.args, input.patches), {
      env: plan ? { ...containerClientEnvironment(), ...plan.passthroughEnvironment } : input.environment,
      cwd: input.workspace,
      signal,
      timeout: input.config.startupTimeoutMs ?? 300000,
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch {
    failure = new Error('Native configuration preparation failed')
  }
  if (plan) {
    try {
      await execFileText(plan.command, ['rm', '--force', '--ignore', plan.containerName], { env: containerClientEnvironment(), timeout: 30000 })
    } catch {
      failure = new Error('Native configuration preparation cleanup failed')
    }
  }
  if (failure) throw failure
  return output!
}
