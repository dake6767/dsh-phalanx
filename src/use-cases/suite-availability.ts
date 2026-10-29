import type { SuiteCatalogEntry, SuiteCatalogEntryUnavailable, SuiteCatalogItem } from '../domain/suite-catalog.js'
import type { SuiteInstallRecord } from '../domain/suite-install.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import { planSharedDependencies } from './suite-replacements.js'

export type SuiteUnavailableReason = { readonly unavailableReason?: SuiteCatalogEntryUnavailable | 'architecture' | 'dependency-missing' }
type SharedPlan = Awaited<ReturnType<typeof planSharedDependencies>>

/** Availability uses one resolved dependency plan per operation, including manual providers. */
export class SuiteAvailability {
  constructor(
    private readonly entries: () => readonly SuiteCatalogEntry[],
    private readonly installs: () => Promise<readonly SuiteInstallRecord[]>,
    private readonly dependencies: Pick<RuntimeDependencies, 'manualProviders' | 'commandOwners'>,
    private readonly itemAvailable: (item: SuiteCatalogItem) => boolean,
  ) {}
  async plan(entry: SuiteCatalogEntry): Promise<SharedPlan> {
    return planSharedDependencies(entry, this.entries(), await this.installs(), this.dependencies)
  }
  async available(entry: SuiteCatalogEntry, shared?: SharedPlan): Promise<boolean> {
    return Object.keys(await this.reason(entry, shared)).length === 0
  }
  async reason(entry: SuiteCatalogEntry, shared?: SharedPlan): Promise<SuiteUnavailableReason> {
    if (entry.unavailableReason) return { unavailableReason: entry.unavailableReason }
    const plan = shared ?? (await this.plan(entry))
    if (entry.category !== 'dependency' && plan.missing.length) return { unavailableReason: 'dependency-missing' }
    const dependenciesAvailable = await Promise.all(plan.install.map(row => this.available(row.entry)))
    return entry.items.every(item => this.itemAvailable(item)) && dependenciesAvailable.every(Boolean) ? {} : { unavailableReason: 'architecture' }
  }
}
