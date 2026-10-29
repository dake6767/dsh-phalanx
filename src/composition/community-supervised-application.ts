import type { CommunityConfig } from '../domain/community-config.js'
import { PlatformDatabaseError } from '../domain/platform-database.js'
import { FileCommunityMaintenance } from '../adapters/community-maintenance.js'
import { StablePublicEntry } from '../inbound/stable-public-entry.js'
import { CommunitySupervisor } from '../use-cases/community-supervisor.js'
import type { CommunitySupervisionPort } from '../ports/community-supervision.js'
import { createCommunityApplication, type CommunityApplicationOptions } from './community-application.js'
import { CommunityConstructionError } from './community-construction.js'

export function createSupervisedCommunityApplication(
  config: CommunityConfig,
  options: Omit<CommunityApplicationOptions, 'publicEntry'> = {},
  supervision: { readonly schedule?: CommunitySupervisionPort['schedule'] } = {},
) {
  const entry = new StablePublicEntry(config.listen, new FileCommunityMaintenance(config.maintenanceFile))
  return new CommunitySupervisor({
    entry,
    create: async () => {
      try {
        return createCommunityApplication(config, { ...options, publicEntry: entry })
      } catch (error) {
        if (error instanceof CommunityConstructionError) {
          await error.cleanup
          throw error.cause
        }
        throw error
      }
    },
    schedule:
      supervision.schedule ??
      (attempt => {
        const timer = setTimeout(() => {
          void attempt()
        }, 3000)
        timer.unref()
        return () => {
          clearTimeout(timer)
        }
      }),
    retryable: error => error instanceof PlatformDatabaseError && error.code === 'unavailable',
    report: () => {
      console.warn('Platform database or configuration is unavailable; inspect the database service and protected deployment configuration')
    },
  })
}
