import type { InitialModelInput, InitialModelView, CommunityModelSettings } from '../domain/admin-contract.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { InitialModelDefaultsPort, SharedModelPublicationPort } from '../ports/initial-model-defaults.js'
import type { SharedModelAdministration } from './shared-model-administration.js'

/** Optional first supply, with the database revision as the only durable progress. */
export class InitialModelSetup {
  constructor(
    private readonly models: SharedModelAdministration,
    private readonly defaults: InitialModelDefaultsPort,
    private readonly publication: SharedModelPublicationPort,
  ) {}
  async view(actor: CommunityAccountActor): Promise<InitialModelView> {
    const settings = await this.models.list(actor)
    const preset = settings.providers.length === 0 ? this.defaults.read() : { status: 'absent' as const }
    const { apiKey, ...values } = preset.status === 'ready' ? preset.values : {}
    return { settings, defaultsStatus: preset.status, defaults: { ...values, apiKey: { configured: Boolean(apiKey) } } }
  }
  async save(actor: CommunityAccountActor, input: InitialModelInput): Promise<CommunityModelSettings> {
    const settings = await this.models.list(actor)
    if (!Number.isSafeInteger(input.revision) || input.revision < 0)
      throw new BusinessRuleError('invalid', 'Invalid model settings revision', 'model-action-invalid')
    // Repeated submits and refreshed pages recover the committed configuration, never create another provider.
    if (settings.providers.length > 0) {
      if (input.revision !== settings.revision && input.revision + 1 !== settings.revision)
        throw new BusinessRuleError('conflict', 'Model settings changed. Reload before saving.', 'model-revision-conflict')
      await this.publication.retry(settings.revision)
      return settings
    }
    const preset = this.defaults.read()
    const apiKey = input.apiKey || (preset.status === 'ready' ? preset.values.apiKey : undefined)
    return this.models.execute(actor, {
      action: 'save-provider',
      revision: input.revision,
      provider: {
        name: input.name,
        baseUrl: input.baseUrl,
        apiFormat: input.apiFormat,
        apiKey: apiKey ?? '',
        enabled: true,
        models: [{ name: input.model, enabled: true }],
      },
    })
  }
}
