import { pluginOfflinePrecheck } from '../dsh/plugin-precheck.js'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { PluginPreparationError, type PluginCandidate, type PreparedPlugin, type PluginPreparationFailureCode } from '../domain/plugin-library.js'
import type { PluginPreparerPort } from '../ports/plugin-library.js'
import type { CommunityPluginStage } from '../domain/admin-contract.js'
import { pluginAddCommand, pluginArtifactPreparation, pluginPreparationHome } from '../dsh/plugin-preparation.js'
import { rootlessContainerUser } from '../dsh/container.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'

/** Disposable rootless preparation containers have no member mounts or platform credentials. */
export class ContainerPluginPreparer implements PluginPreparerPort {
  private cleanupFailed = false
  constructor(private readonly config: CommunityRuntimeConfig) {}
  async recover(): Promise<void> {
    const container = this.config.container
    if (!container) return
    const env = containerClientEnvironment()
    const ownership = createHash('sha256').update(resolve(this.config.dataRoot)).digest('hex')
    const ids = (await execFileText(container.runtime, ['ps', '-a', '--filter', `label=dsh-phalanx.precheck=${ownership}`, '--format', '{{.ID}}'], { env, timeout: 30_000 })).trim().split(/\s+/u).filter(Boolean)
    for (const id of ids) {
      if (!/^[a-f0-9]{12,64}$/u.test(id)) throw new Error('Invalid preparation container identity')
      const label = (await execFileText(container.runtime, ['inspect', '--format', '{{index .Config.Labels "dsh-phalanx.precheck"}}', id], { env, timeout: 30_000 })).trim()
      if (label !== ownership) throw new Error('Preparation container ownership changed')
      await execFileText(container.runtime, ['rm', '-f', id], { env, timeout: 30_000 })
    }
    await rm(join(this.config.dataRoot, 'plugins', 'staging'), { recursive: true, force: true })
    this.cleanupFailed = false
  }
  async prepare(input: PluginCandidate, progress: (stage: Exclude<CommunityPluginStage, 'available' | 'failed'>) => void, signal: AbortSignal): Promise<PreparedPlugin> {
    if (this.cleanupFailed) throw new PluginPreparationError('plugin-cleanup-failed')
    const container = this.config.container
    if (!container) throw new PluginPreparationError('plugin-runtime-required')
    const root = resolve(this.config.dataRoot, 'plugins')
    await mkdir(join(root, 'staging'), { recursive: true, mode: 0o700 })
    const staging = await mkdtemp(join(root, 'staging', 'addition-'))
    const work = join(staging, 'work'), control = join(staging, 'control')
    const ownership = createHash('sha256').update(resolve(this.config.dataRoot)).digest('hex')
    const env = containerClientEnvironment()
    const name = `dsh-phalanx-precheck-${randomUUID()}`
    let cleanupConfirmed = true
    try {
      const image = JSON.parse(await execFileText(container.runtime, ['image', 'inspect', container.image], { env, timeout: 30_000 })) as Array<{ Id: string, Config: { Labels: Record<string, string> } }>
      const selected = image[0]
      const runtimeRevision = selected?.Config.Labels['dsh.revision']
      if (!selected || !/^(sha256:)?[a-f0-9]{64}$/u.test(selected.Id) || !runtimeRevision || !/^[a-f0-9]{40}$/u.test(runtimeRevision)) throw new PluginPreparationError('plugin-runtime-required')
      await mkdir(work); await mkdir(control)
      await writeFile(join(control, 'input.json'), JSON.stringify({ packageName: input.packageName, version: input.version, runtimeRevision, ...(input.retainedIntegrity || input.upload ? { uploadIntegrity: input.retainedIntegrity ?? input.upload!.integrity } : {}) }), { mode: 0o600 })
      await writeFile(join(control, 'prepare.mjs'), pluginArtifactPreparation, { mode: 0o600 })
      await writeFile(join(control, 'precheck.mjs'), pluginOfflinePrecheck, { mode: 0o600 })
      const run = async (command: readonly string[], network: boolean, offlineBoot = false): Promise<string> => {
        signal.throwIfAborted()
        cleanupConfirmed = false
        const result = await execFileText(container.runtime, ['run', '--rm', '--name', name, '--label', `dsh-phalanx.precheck=${ownership}`,
            '--userns=keep-id', '--user', rootlessContainerUser(), '--network', network ? 'pasta:-4' : 'none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--pids-limit=256', '--memory=2g', '--cpus=2', '--volume', `${work}:/prepare${offlineBoot ? ':ro' : ''}`, '--volume', `${control}:/control:ro`,
            ...(offlineBoot ? ['--volume', `${work}/checkhome:/checkhome`, '--volume', `${work}/prepared/${runtimeRevision}:/artifact:ro`] : []),
            '--workdir', offlineBoot ? '/checkhome' : '/prepare', '--env', `HOME=${offlineBoot ? '/checkhome' : pluginPreparationHome}`, '--env', `DSH_HOME=${offlineBoot ? '/checkhome' : pluginPreparationHome}/.dsh`,
            '--env', 'DSH_TELEMETRY_DISABLED=1', '--env', 'npm_config_ignore_scripts=true', selected.Id, ...command],
          { env, signal, timeout: 600_000, maxBuffer: 8 * 1024 * 1024, reportOutputOnFailure: false })
          .then(output => ({ ok: true as const, output }), (error: unknown) => ({ ok: false as const, error }))
        // Confirm exit before deleting files, including after an aborted or timed-out client.
        try {
          await execFileText(container.runtime, ['rm', '-f', '--ignore', name], { env, timeout: 30_000 })
          cleanupConfirmed = true
        } catch (error) { this.cleanupFailed = true; throw new PluginPreparationError('plugin-cleanup-failed', { cause: error }) }
        if (!result.ok) {
          const error = result.error
          let failure: { code?: string } = {}
          try { failure = JSON.parse(await readFile(join(work, 'failure.json'), 'utf8')) as { code?: string } }
          catch { /* Missing diagnostics retain the generic failure. */ }
          if (failure.code === 'plugin-dependency-invalid' || failure.code === 'plugin-package-invalid' || failure.code === 'plugin-integrity-invalid')
            throw new PluginPreparationError(failure.code, { cause: error })
          throw error
        }
        return result.output
      }
      if (input.retainedIntegrity) {
        if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(input.retainedIntegrity)) throw new PluginPreparationError('plugin-integrity-invalid')
        const digest = Buffer.from(input.retainedIntegrity.slice(7), 'base64')
        if (`sha512-${digest.toString('base64')}` !== input.retainedIntegrity) throw new PluginPreparationError('plugin-integrity-invalid')
        const archive = join(root, 'artifacts', digest.toString('hex'), 'original.tgz')
        if (!(await lstat(archive)).isFile()) throw new PluginPreparationError('plugin-package-invalid')
        await copyFile(archive, join(work, 'original.tgz'))
      } else if (input.upload) {
        const archive = resolve(input.upload.archive)
        if (!archive.startsWith(`${resolve(this.config.dataRoot, 'plugins/uploads/archives')}/`) || !(await lstat(archive)).isFile()) throw new PluginPreparationError('plugin-package-invalid')
        await copyFile(archive, join(work, 'original.tgz'))
      }
      progress('downloading')
      await run(['node', '/control/prepare.mjs', input.retainedIntegrity || input.upload ? 'upload' : 'download'], !input.retainedIntegrity && !input.upload)
      const pinned = JSON.parse(await readFile(join(work, 'identity.json'), 'utf8')) as { integrity: string }
      progress('installing')
      await run(pluginAddCommand(), true)
      await run(['node', '/control/prepare.mjs', 'inspect'], false)
      progress('prechecking')
      await run(['node', '/control/precheck.mjs'], false, true)
      signal.throwIfAborted()
      const metadata = JSON.parse(await readFile(join(work, 'prepared', runtimeRevision, 'manifest.json'), 'utf8')) as Omit<PreparedPlugin, 'artifact'>
      const hash = createHash('sha512')
      for await (const chunk of createReadStream(join(work, 'original.tgz'))) hash.update(chunk)
      const digest = hash.digest()
      if (`sha512-${digest.toString('base64')}` !== pinned.integrity || metadata.integrity !== pinned.integrity || metadata.packageName !== input.packageName || metadata.version !== input.version)
        throw new PluginPreparationError('plugin-integrity-invalid')
      const preparationId = `${runtimeRevision}-${randomUUID()}`
      await writeFile(join(work, 'prepared', runtimeRevision, 'manifest.json'), JSON.stringify({ ...metadata, preparationId, precheck: { status: 'passed', imageId: selected.Id } }), { mode: 0o600 })
      await rename(join(work, 'prepared', runtimeRevision), join(work, 'prepared', preparationId))
      const artifact = `artifacts/${digest.toString('hex')}`
      await mkdir(join(root, 'artifacts'), { recursive: true, mode: 0o700 })
      await rm(join(work, 'home'), { recursive: true, force: true })
      await rm(join(work, 'checkhome'), { recursive: true, force: true })
      try { await rename(work, join(root, artifact)) }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        // Add the new runtime immutably. Old runtime directories can still be mounted.
        await mkdir(join(root, artifact, 'prepared'), { recursive: true, mode: 0o700 })
        try { await rename(join(work, 'prepared', preparationId), join(root, artifact, 'prepared', preparationId)) }
        catch (conflict) { if (!['EEXIST', 'ENOTEMPTY'].includes((conflict as NodeJS.ErrnoException).code ?? '')) throw conflict }
        const existing = JSON.parse(await readFile(join(root, artifact, 'prepared', preparationId, 'manifest.json'), 'utf8')) as PreparedPlugin
        if (existing.integrity !== metadata.integrity || existing.version !== input.version || existing.packageName !== input.packageName) throw new PluginPreparationError('plugin-integrity-invalid')
      }
      return { ...metadata, artifact, preparationId }
    } catch (error) {
      if (error instanceof PluginPreparationError) throw error
      // Child output is not exposed: it can include arbitrary plugin text and private paths.
      const code: PluginPreparationFailureCode = signal.aborted ? 'plugin-job-interrupted' : 'plugin-precheck-failed'
      throw new PluginPreparationError(code, { cause: error })
    } finally {
      if (cleanupConfirmed) await rm(staging, { recursive: true, force: true })
    }
  }
}
