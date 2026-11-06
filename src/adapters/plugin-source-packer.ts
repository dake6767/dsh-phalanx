import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { assertPluginIdentity, PluginPreparationError, pluginSourceAbortCode, type PluginPreparationFailureCode } from '../domain/plugin-library.js'
import type { PluginSourcePackerPort } from '../ports/plugin-source.js'
import { rootlessContainerUser } from '../dsh/container.js'
import { pluginSourcePacking } from '../dsh/plugin-source-pack.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'

/** Unpacked repository plus its npm pack copy; the packing script itself refuses sources above 500 MB. */
const SCRATCH_BYTES = 1024 * 1024 * 1024
type PackResult = { ok: true; packageName: string; version: string; filename: string } | { ok: false; code?: string }
const packFailures: readonly PluginPreparationFailureCode[] = ['plugin-build-required', 'plugin-dependency-invalid', 'plugin-package-invalid']

/** Interprets the packing result; shared with the host-local test packer that runs the same script. */
export function packedPlugin(output: string, directory: string): { packageName: string; version: string; archive: string } {
  let result: PackResult
  try {
    result = JSON.parse(output) as PackResult
  } catch (cause) {
    throw new PluginPreparationError('plugin-package-invalid', { cause })
  }
  if (!result.ok) throw new PluginPreparationError(packFailures.find(code => code === result.code) ?? 'plugin-package-invalid')
  if (!/^[^/\\]{1,240}\.tgz$/u.test(result.filename)) throw new PluginPreparationError('plugin-package-invalid')
  try {
    assertPluginIdentity(result)
  } catch (cause) {
    throw new PluginPreparationError('plugin-package-invalid', { cause })
  }
  return { packageName: result.packageName, version: result.version, archive: join(directory, result.filename) }
}

/** Repository source is extracted and packed only in a network-disabled, read-only container; no repository script runs. */
export class ContainerPluginSourcePacker implements PluginSourcePackerPort {
  /** Set when a container exit could not be confirmed; refused until a restart recovers labelled containers and staging. */
  private cleanupFailed = false
  constructor(private readonly config: CommunityRuntimeConfig) {}
  async pack(sourceArchive: string, directory: string, signal: AbortSignal) {
    if (this.cleanupFailed) throw new PluginPreparationError('plugin-cleanup-failed')
    const container = this.config.container
    if (!container) throw new PluginPreparationError('plugin-runtime-required')
    const output = join(directory, 'output')
    await mkdir(output)
    const name = `dsh-phalanx-source-${randomUUID()}`
    const ownership = createHash('sha256').update(resolve(this.config.dataRoot)).digest('hex')
    const env = containerClientEnvironment()
    const result = await execFileText(
      container.runtime,
      [
        'run',
        '--http-proxy=false',
        '--rm',
        '--name',
        name,
        '--label',
        `dsh-phalanx.precheck=${ownership}`,
        '--userns=keep-id',
        '--user',
        rootlessContainerUser(),
        '--network',
        'none',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit=128',
        '--memory=2g',
        '--cpus=1',
        '--read-only',
        '--tmpfs',
        '/tmp:rw,size=64m',
        '--volume',
        `${resolve(sourceArchive)}:/source.tar.gz:ro`,
        '--volume',
        `${output}:/output`,
        // Extraction and packing happen in a size-limited tmpfs, so an archive cannot expand onto the platform disk.
        '--tmpfs',
        `/scratch:rw,size=${SCRATCH_BYTES}`,
        '--workdir',
        '/scratch',
        '--env',
        'HOME=/scratch',
        container.image,
        'node',
        '--input-type=module',
        '-e',
        pluginSourcePacking,
        '--',
        '--pack',
        '/source.tar.gz',
        '/output',
        '/scratch',
      ],
      { env, signal, timeout: 600_000, maxBuffer: 1024 * 1024, reportOutputOnFailure: false },
    ).then(
      value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    // Confirm exit before the caller may delete the mounted output, including after an aborted or timed-out client.
    try {
      await execFileText(container.runtime, ['rm', '-f', '--ignore', name], { env, timeout: 30_000 })
    } catch (error) {
      this.cleanupFailed = true
      throw new PluginPreparationError('plugin-cleanup-failed', { cause: error })
    }
    if (!result.ok)
      throw new PluginPreparationError(signal.aborted ? pluginSourceAbortCode(signal, 'plugin-precheck-failed') : 'plugin-package-invalid', {
        cause: result.error,
      })
    const packed = packedPlugin(result.value, output)
    if ((await readdir(output)).length !== 1) throw new PluginPreparationError('plugin-package-invalid')
    return packed
  }
}
