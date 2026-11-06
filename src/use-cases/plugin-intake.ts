import type { CommunityPluginPreview, CommunityPluginStage, CommunityPluginView } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { pluginSourceRequest, type PluginSourceRequest } from '../domain/plugin-intake.js'
import {
  assertPreparedPlugin,
  githubPluginSource,
  npmPluginSource,
  PluginPreparationError,
  type PluginCandidate,
  type PluginSource,
  type PreparedPlugin,
  type UploadedPlugin,
} from '../domain/plugin-library.js'
import type { Clock } from '../ports/clock.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginPreparerPort } from '../ports/plugin-library.js'
import type { GithubPluginArchivePort, NpmPluginSourcePort } from '../ports/plugin-source.js'
import { KeyedOperations } from './support/keyed-operations.js'

type State =
  | { stage: Exclude<CommunityPluginStage, 'available' | 'failed'> }
  | { stage: 'ready'; prepared: PreparedPlugin }
  | { stage: 'failed'; failureCode: PluginPreparationError['code'] | AdmissionFailure }
type Preview = {
  token: string
  actor: CommunityAccountActor
  input: string
  request: PluginSourceRequest
  expires: number
  submittedAt: number
  resolved?: PluginCandidate
  /** GitHub requests: the default-branch commit pinned by the first attempt; retries keep it. */
  commit?: string
  uploaded?: UploadedPlugin | undefined
  /** Set while confirmation adopts this preview; expiry then leaves the archive to the adoption outcome. */
  confirming?: boolean
  state: State
  controller: AbortController
  completion: Promise<void>
}

/** A GitHub package name is known only after packing, so library admission can fail inside the precheck. */
const admissionFailures = ['plugin-source-conflict', 'plugin-name-in-use', 'plugin-job-busy', 'suite-entry-locked'] as const
type AdmissionFailure = (typeof admissionFailures)[number]

/** Owns unconfirmed work; no preview is an authorizable library entry. */
export class PluginIntake {
  private readonly previews = new Map<string, Preview>()
  private readonly active = new Set<Preview>()
  private readonly operations = new KeyedOperations()
  private stopped = false
  private cleanupFailed = false
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get'>,
    private readonly source: NpmPluginSourcePort,
    private readonly preparer: PluginPreparerPort,
    private readonly admit: (actor: CommunityAccountActor, packageName: string, source: PluginSource) => Promise<void>,
    private readonly adopt: (
      actor: CommunityAccountActor,
      candidate: PluginCandidate,
      prepared: PreparedPlugin,
      submittedAt: number,
      source: PluginSource,
    ) => Promise<CommunityPluginView>,
    private readonly clock: Clock,
    private readonly newToken: () => string,
    private readonly github?: GithubPluginArchivePort,
  ) {}
  async create(actor: CommunityAccountActor, input: string): Promise<CommunityPluginPreview> {
    await this.admin(actor)
    this.expire()
    const request = pluginSourceRequest(input)
    // A GitHub package name is known only after packing; admission is checked again then.
    if (request.kind === 'npm') await this.admit(actor, request.packageName, npmPluginSource)
    else if (!this.github) throw new PluginPreparationError('plugin-runtime-required')
    if (this.stopped) throw new PluginPreparationError('plugin-job-interrupted')
    const row: Preview = {
      token: this.newToken(),
      actor: { ...actor },
      input: input.trim(),
      request,
      expires: this.clock.now() + 30 * 60 * 1000,
      submittedAt: this.clock.now(),
      state: { stage: 'resolving' },
      controller: new AbortController(),
      completion: Promise.resolve(),
    }
    this.previews.set(row.token, row)
    this.launch(row)
    return this.view(row)
  }
  async read(actor: CommunityAccountActor, token: string): Promise<CommunityPluginPreview> {
    await this.admin(actor)
    return this.view(this.required(actor, token))
  }
  confirm(actor: CommunityAccountActor, token: string): Promise<CommunityPluginView> {
    return this.operations.run(token, async () => {
      await this.admin(actor)
      if (this.stopped) throw new PluginPreparationError('plugin-job-interrupted')
      const row = this.required(actor, token)
      if (row.state.stage !== 'ready' || !row.resolved) throw new BusinessRuleError('conflict', 'Wait for the plugin precheck to finish.', 'plugin-job-busy')
      row.confirming = true
      let result: CommunityPluginView
      try {
        result = await this.adopt(actor, row.resolved, row.state.prepared, row.submittedAt, this.recordedSource(row))
      } catch (error) {
        row.confirming = false
        // Expired while adoption failed: nothing owns the archive any longer.
        if (!this.previews.has(token)) await this.release(row)
        throw error
      }
      // The library row now owns the archive.
      row.uploaded = undefined
      this.previews.delete(token)
      return result
    })
  }
  retry(actor: CommunityAccountActor, token: string): Promise<CommunityPluginPreview> {
    return this.operations.run(token, async () => {
      await this.admin(actor)
      const row = this.required(actor, token)
      if (row.state.stage !== 'failed') throw new BusinessRuleError('conflict', 'Wait for the plugin precheck to finish.', 'plugin-job-busy')
      await row.completion
      row.controller = new AbortController()
      row.state = { stage: 'resolving' }
      row.expires = this.clock.now() + 30 * 60 * 1000
      this.launch(row)
      return this.view(row)
    })
  }
  cancel(actor: CommunityAccountActor, token: string): Promise<void> {
    return this.operations.run(token, async () => {
      await this.admin(actor)
      const row = this.required(actor, token)
      row.controller.abort()
      await row.completion
      if (row.state.stage === 'failed' && row.state.failureCode === 'plugin-cleanup-failed') throw new PluginPreparationError('plugin-cleanup-failed')
      this.previews.delete(token)
      await this.release(row)
    })
  }
  private launch(row: Preview): void {
    if (this.stopped) throw new PluginPreparationError('plugin-job-interrupted')
    this.active.add(row)
    row.completion = this.prepare(row)
    void row.completion.then(
      () => this.active.delete(row),
      () => this.active.delete(row),
    )
  }
  async stop(): Promise<void> {
    this.stopped = true
    for (const row of this.active) row.controller.abort()
    await this.operations.drain()
    await Promise.all([...this.active].map(row => row.completion))
    if (this.cleanupFailed) throw new PluginPreparationError('plugin-cleanup-failed')
    for (const row of this.previews.values()) await this.release(row)
    this.previews.clear()
  }
  private async prepare(row: Preview): Promise<void> {
    const signal = row.controller.signal
    try {
      if (row.request.kind === 'github') await this.fetchGithub(row, row.request.repository, signal)
      else if (!row.resolved) {
        const input = row.request
        row.resolved = input.version === 'latest' ? await this.source.resolve(input, signal) : { packageName: input.packageName, version: input.version }
      }
      signal.throwIfAborted()
      if (!row.resolved) throw new PluginPreparationError('plugin-precheck-failed')
      const prepared = await this.preparer.prepare(
        row.resolved,
        async stage => {
          signal.throwIfAborted()
          row.state = { stage }
        },
        signal,
      )
      signal.throwIfAborted()
      assertPreparedPlugin(row.resolved, prepared)
      row.state = { stage: 'ready', prepared: row.commit ? { ...prepared, sourceCommit: row.commit } : prepared }
    } catch (error) {
      if (error instanceof PluginPreparationError && error.code === 'plugin-cleanup-failed') this.cleanupFailed = true
      row.state = {
        stage: 'failed',
        failureCode:
          error instanceof PluginPreparationError
            ? error.code
            : error instanceof BusinessRuleError && admissionFailures.some(code => code === error.code)
              ? (error.code as AdmissionFailure)
              : signal.aborted
                ? 'plugin-job-interrupted'
                : 'plugin-precheck-failed',
      }
    }
  }
  private view(row: Preview): CommunityPluginPreview {
    return {
      token: row.token,
      input: row.input,
      source: row.request.kind,
      ...(row.request.kind === 'github' ? { repository: row.request.repository } : {}),
      ...(row.commit ? { sourceCommit: row.commit } : {}),
      stage: row.state.stage,
      ...(row.resolved ? { packageName: row.resolved.packageName, version: row.resolved.version } : {}),
      ...(row.state.stage === 'ready'
        ? {
            title: row.state.prepared.title,
            description: row.state.prepared.description,
            dependencies: row.state.prepared.dependencies,
            integrity: row.state.prepared.integrity,
          }
        : {}),
      ...(row.state.stage === 'failed' ? { failureCode: row.state.failureCode } : {}),
    }
  }
  private expire(): void {
    for (const [token, row] of this.previews)
      if (row.expires <= this.clock.now()) {
        row.controller.abort()
        this.previews.delete(token)
        if (!row.confirming) void row.completion.then(() => this.release(row)).catch(() => undefined)
      }
  }
  /** Pins the default branch once, then packs that commit; a retry re-uses the packed archive when it exists. */
  private async fetchGithub(row: Preview, repository: string, signal: AbortSignal): Promise<void> {
    const github = this.github
    if (!github) throw new PluginPreparationError('plugin-runtime-required')
    if (!row.commit) row.commit = (await github.resolve(repository, signal)).commit
    signal.throwIfAborted()
    if (!row.uploaded) {
      row.state = { stage: 'downloading' }
      row.uploaded = await github.pack({ repository, commit: row.commit }, signal)
    }
    signal.throwIfAborted()
    await this.admit(row.actor, row.uploaded.packageName, githubPluginSource(repository))
    row.resolved = {
      packageName: row.uploaded.packageName,
      version: row.uploaded.version,
      upload: { archive: row.uploaded.archive, integrity: row.uploaded.integrity },
    }
  }
  private recordedSource(row: Preview): PluginSource {
    return row.request.kind === 'github' ? githubPluginSource(row.request.repository) : npmPluginSource
  }
  private async release(row: Preview): Promise<void> {
    const archive = row.uploaded?.archive
    row.uploaded = undefined
    if (archive) await this.github?.discard(archive)
  }
  private required(actor: CommunityAccountActor, token: string): Preview {
    this.expire()
    const row = this.previews.get(token)
    if (!row || row.actor.username !== actor.username || row.actor.spaceId !== actor.spaceId || row.actor.sessionEpoch !== actor.sessionEpoch)
      throw new BusinessRuleError('missing', 'The plugin precheck expired. Start a new precheck.', 'plugin-preview-unavailable')
    return row
  }
  private async admin(actor: CommunityAccountActor): Promise<void> {
    const account = await this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
