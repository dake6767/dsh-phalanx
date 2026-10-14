import { createHash, randomUUID } from 'node:crypto'
import { pluginCompatibilityTarget } from './runtime-revision.js'
import { cp, mkdir, readFile, readdir, rename, rm, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { PluginPreparationError, type PluginCandidate } from '../domain/plugin-library.js'
import type { PluginContributionArtifact, PluginContributionInput, PluginContributionPreparationPort, PreparedPluginContribution } from '../ports/plugin-contributions.js'
import type { ContributionFinding } from '../domain/member-contribution.js'
import { redactContributionContent } from '../domain/contribution-checks.js'
import { FilePluginUpload } from './plugin-upload.js'
import { ContainerPluginPreparer } from './plugin-preparer.js'
import { ContainerPluginArchiveInspector } from './plugin-archive-inspector.js'

/** Pending packages use a separate preparation root; approval copies immutable prepared bytes. */
export class FilePluginContributionPreparation implements PluginContributionPreparationPort {
  private readonly target = pluginCompatibilityTarget()
  private readonly root: string
  private readonly live: string
  private readonly uploads: FilePluginUpload
  private readonly preparer: ContainerPluginPreparer
  constructor(config: CommunityRuntimeConfig) {
    this.root = resolve(config.dataRoot, 'contributions/plugin-intake')
    this.live = resolve(config.dataRoot, 'plugins')
    const privateConfig = { ...config, dataRoot: this.root }
    this.uploads = new FilePluginUpload(this.root, new ContainerPluginArchiveInspector(privateConfig))
    this.preparer = new ContainerPluginPreparer(privateConfig, true)
  }
  async prepare(input: PluginContributionInput, signal: AbortSignal): Promise<PreparedPluginContribution> {
    let candidate: PluginCandidate
    if (input.source === 'upload') {
      const uploaded = await this.uploads.accept(input.filename, input.content, signal)
      candidate = { packageName: uploaded.packageName, version: uploaded.version, upload: { archive: uploaded.archive, integrity: uploaded.integrity } }
    } else candidate = { packageName: input.packageName, version: input.version }
    const raw = await this.preparer.prepare(candidate, () => {}, signal)
    const prepared = { ...raw, title: redactContributionContent(raw.title), description: redactContributionContent(raw.description) }
    const inspection = JSON.parse(await readFile(join(this.root, 'plugins', prepared.artifact, 'contribution.json'), 'utf8')) as { files: string[], keyFiles: { path: string, content: string }[], findings: ContributionFinding[] }
    return { name: prepared.packageName, description: redactContributionContent(prepared.description), markdown: '', hash: createHash('sha256').update(await readFile(join(this.root, 'plugins', prepared.artifact, 'original.tgz'))).digest('hex'), ...inspection, plugin: { candidate, prepared, checkedFor: this.target } }
  }
  async publish(artifact: PluginContributionArtifact, commit: (promoted: PluginContributionArtifact, retained: () => void) => void): Promise<void> {
    if (artifact.checkedFor !== this.target) {
      const raw = await this.preparer.prepare({ packageName: artifact.prepared.packageName, version: artifact.prepared.version, retainedIntegrity: artifact.prepared.integrity }, () => {}, new AbortController().signal)
      artifact = { ...artifact, prepared: { ...raw, title: redactContributionContent(raw.title), description: redactContributionContent(raw.description) }, checkedFor: this.target }
    }
    const { prepared } = artifact
    this.assertPaths(artifact)
    const source = join(this.root, 'plugins', prepared.artifact)
    const target = join(this.live, prepared.artifact)
    const preparation = prepared.preparationId!
    await mkdir(join(this.live, 'staging'), { recursive: true, mode: 0o700 })
    const staging = await mkdtemp(join(this.live, 'staging', 'contribution-'))
    let retained = false, created = false, addedPreparation = false, archive: string | undefined
    try {
      await cp(source, join(staging, 'artifact'), { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
      await mkdir(join(this.live, 'artifacts'), { recursive: true, mode: 0o700 })
      try { await rename(join(staging, 'artifact'), target); created = true }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        await mkdir(join(target, 'prepared'), { recursive: true, mode: 0o700 })
        await rename(join(staging, 'artifact/prepared', preparation), join(target, 'prepared', preparation)); addedPreparation = true
      }
      // A contributed upload is retained by integrity in the live library; private upload paths never cross roots.
      if (artifact.candidate.upload) {
        await mkdir(join(this.live, 'uploads/archives'), { recursive: true, mode: 0o700 })
        archive = join(this.live, 'uploads/archives', randomUUID() + '.tgz')
        await cp(join(target, 'original.tgz'), archive, { errorOnExist: true, force: false })
      }
      const candidate: PluginCandidate = { packageName: prepared.packageName, version: prepared.version, ...(archive ? { upload: { archive, integrity: prepared.integrity } } : { retainedIntegrity: prepared.integrity }) }
      commit({ candidate, prepared, checkedFor: this.target }, () => { retained = true })
    } finally {
      if (!retained && created) await rm(target, { recursive: true, force: true })
      else if (!retained && addedPreparation) await rm(join(target, 'prepared', preparation), { recursive: true, force: true })
      if (!retained && archive) await rm(archive, { force: true })
      await rm(staging, { recursive: true, force: true })
    }
  }
  async recover(retained: readonly PluginContributionArtifact[]): Promise<void> {
    for (const artifact of retained) this.assertPaths(artifact)
    await this.preparer.recover()
    await this.uploads.recover(retained.flatMap(row => row.candidate.upload ? [row.candidate.upload.archive] : []))
    const root = join(this.root, 'plugins/artifacts'), keep = new Set(retained.map(row => row.prepared.artifact))
    const names = await readdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    for (const name of names) if (!keep.has(`artifacts/${name}`)) await rm(join(root, name), { recursive: true, force: true })
  }
  private assertPaths({ prepared }: PluginContributionArtifact): void {
    if (!/^artifacts\/[a-f0-9]{128}$/u.test(prepared.artifact) || !/^[a-f0-9]{40}-[a-f0-9-]{36}$/u.test(prepared.preparationId ?? '')) throw new PluginPreparationError('plugin-integrity-invalid')
    const digest = Buffer.from(prepared.integrity.slice(7), 'base64')
    if (`sha512-${digest.toString('base64')}` !== prepared.integrity || `artifacts/${digest.toString('hex')}` !== prepared.artifact) throw new PluginPreparationError('plugin-integrity-invalid')
  }
}
