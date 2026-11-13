import type { CatalogServiceField } from '../../src/domain/suite-service-slots'
import type { CommunityCatalogServiceDefinition } from '../../src/domain/suite-contract'
import { CommunityApiRequestError, publishCommunityPlugin, updateCommunityGroupPlugins } from './community-api'
import type { CatalogPluginDistributionIdentity } from '../../src/domain/plugin-group-contract'
import { changeCommunityInstalledServices, communityInstalledServices } from './community-installed-services-api'

interface CatalogSetupTask {
  readonly label: string
  readonly kind: 'service' | 'preinstall' | 'publish'
  readonly owner?: string
  retryable?(): boolean
  run(confirmed?: true): Promise<unknown>
}

export function serviceDraftKey(owner: CommunityCatalogServiceDefinition, slot: string, backend: string) {
  return JSON.stringify([owner.kind, owner.name, slot, backend])
}

function fieldSignature(fields: readonly CatalogServiceField[]) {
  return JSON.stringify(fields.map(({ name, type, required, requiredGroup }) => [name, type, required, requiredGroup]))
}

export function catalogServiceActions(
  definitions: readonly CommunityCatalogServiceDefinition[],
  drafts: Readonly<Record<string, Readonly<Record<string, string>>>>,
  locale: 'en' | 'zh-CN',
  expected: { id: string; version: string; contentHash?: string },
  changedMessage: string,
): CatalogSetupTask[] {
  return definitions.flatMap(owner => {
    const ownerKey = JSON.stringify([owner.kind, owner.name])
    let revision: string | undefined
    let requiresReview = false
    return owner.slots.flatMap(slot =>
      slot.backends.flatMap(backend => {
        const key = serviceDraftKey(owner, slot.id, backend.id)
        const values = drafts[key]
        if (!values || !Object.values(values).some(value => value.trim())) return []
        return [
          {
            kind: 'service',
            owner: ownerKey,
            label: slot.label[locale] + ' · ' + backend.label[locale],
            retryable: () => !requiresReview,
            async run() {
              if (requiresReview) throw new Error(changedMessage)
              const installed = await communityInstalledServices(owner).catch(failure => {
                if (revision === undefined) requiresReview = true
                throw failure
              })
              const available = installed.slots.find(row => row.id === slot.id)?.backends.find(row => row.id === backend.id)
              // A new catalog version must be reviewed before draft fields are applied to it.
              if (
                installed.identity.id !== expected.id ||
                installed.identity.version !== expected.version ||
                installed.identity.contentHash !== expected.contentHash ||
                (revision !== undefined && installed.revision !== revision) ||
                !available ||
                fieldSignature(available.fields) !== fieldSignature(backend.fields)
              ) {
                requiresReview = true
                throw new Error(changedMessage)
              }
              revision ??= installed.revision
              try {
                const committed = await changeCommunityInstalledServices(owner, revision, { action: 'save', slot: slot.id, backend: backend.id, values })
                revision = committed.revision
              } catch (failure) {
                if (failure instanceof CommunityApiRequestError && [400, 404, 409].includes(failure.status)) requiresReview = true
                throw failure
              }
            },
          },
        ]
      }),
    )
  })
}

export function catalogPluginDistribution(
  expected: CatalogPluginDistributionIdentity,
  groups: readonly { id: string; name: string }[],
  publish: boolean,
  publishLabel: string,
): CatalogSetupTask[] {
  const actions: CatalogSetupTask[] = groups.map(({ id, name }) => ({
    kind: 'preinstall',
    label: name,
    run: () => updateCommunityGroupPlugins(id, { action: 'catalog-preinstall', plugin: expected }),
  }))
  if (publish)
    actions.push({
      kind: 'publish',
      label: publishLabel,
      run: confirmed =>
        publishCommunityPlugin({ action: 'publish', packageName: expected.packageName, published: true, expected, ...(confirmed ? { confirmed } : {}) }),
    })
  return actions
}
