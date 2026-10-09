import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { assertPluginIdentity, PluginPreparationError, type PluginIdentity } from '../domain/plugin-library.js'
import type { PluginArchiveInspectorPort } from '../ports/plugin-library.js'
import { pluginArchiveInspection } from '../dsh/plugin-archive.js'
import { rootlessContainerUser } from '../dsh/container.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'

/** The incoming archive is the only writable-platform file exposed, and is mounted read-only. */
export class ContainerPluginArchiveInspector implements PluginArchiveInspectorPort {
  constructor(private readonly config: CommunityRuntimeConfig) {}
  async inspect(archive: string, signal: AbortSignal): Promise<PluginIdentity> {
    const container = this.config.container
    if (!container) throw new PluginPreparationError('plugin-runtime-required')
    const name = `dsh-phalanx-upload-${randomUUID()}`
    const ownership = createHash('sha256').update(resolve(this.config.dataRoot)).digest('hex')
    const env = containerClientEnvironment()
    const result = await execFileText(container.runtime, ['run', '--rm', '--name', name, '--label', `dsh-phalanx.precheck=${ownership}`,
      '--userns=keep-id', '--user', rootlessContainerUser(), '--network', 'none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=64', '--memory=512m', '--cpus=1', '--read-only', '--volume', `${archive}:/upload.tgz:ro`,
      container.image, 'node', '--input-type=module', '-e', pluginArchiveInspection], { env, signal, timeout: 60000, maxBuffer: 1024 * 1024 })
      .then(output => ({ ok: true as const, output }), (error: unknown) => ({ ok: false as const, error }))
    try { await execFileText(container.runtime, ['rm', '-f', '--ignore', name], { env, timeout: 30000 }) }
    catch (error) { throw new PluginPreparationError('plugin-cleanup-failed', { cause: error }) }
    if (!result.ok) throw new PluginPreparationError(signal.aborted ? 'plugin-job-interrupted' : 'plugin-package-invalid', { cause: result.error })
    const manifest = JSON.parse(result.output) as { ok: boolean, code?: string, packageName: string, version: string }
    if (!manifest.ok) throw new PluginPreparationError(manifest.code === 'plugin-dependency-invalid' ? manifest.code : 'plugin-package-invalid')
    assertPluginIdentity(manifest)
    return { packageName: manifest.packageName, version: manifest.version }
  }
}
