import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { PASTA_HOST_LOOPBACK_OPTION } from '../dsh/container.js'
import { CommunityRuntimeUnavailableError } from '../ports/community-runtime.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'

/** Observe the same helper Podman resolves, without guessing from distribution or package versions. */
export async function readPastaLoopbackMapping(
  runtime: string,
  signal: AbortSignal,
  passthroughEnvironment: Readonly<Record<string, string>> = {},
): Promise<boolean> {
  try {
    const env = { ...containerClientEnvironment(), ...passthroughEnvironment }
    const info: { host?: { pasta?: { executable?: unknown } } } = JSON.parse(
      await execFileText(runtime, ['info', '--format', 'json'], { env, signal, timeout: 10000, maxBuffer: 256 * 1024 }),
    )
    const helper = info?.host?.pasta?.executable
    if (typeof helper !== 'string' || !isAbsolute(helper)) throw new Error('Podman did not identify its pasta helper')
    const help = await new Promise<string>((resolveHelp, reject) => {
      execFile(
        helper,
        ['--help'],
        { env: containerClientEnvironment(), signal, timeout: 10000, maxBuffer: 256 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error) reject(error)
          else resolveHelp(`${stdout}\n${stderr}`)
        },
      )
    })
    const options = new Set(help.split(/[\s,]+/u))
    if (!options.has('--tcp-ports')) throw new Error('Pasta did not report its supported options')
    return options.has(PASTA_HOST_LOOPBACK_OPTION)
  } catch (cause) {
    signal.throwIfAborted()
    throw new CommunityRuntimeUnavailableError('startup-unavailable', 'Container loopback forwarding capability could not be determined', { cause })
  }
}
