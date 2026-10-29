import type { ContributionMaintenancePort } from '../ports/member-contributions.js'
/** Lifecycle-owned cleanup for continuously running installations. */
export class ContributionMaintenance implements ContributionMaintenancePort {
  start(cleanup: () => Promise<void>): () => void {
    const timer = setInterval(
      () => {
        void cleanup().catch(() => console.warn('Contribution cleanup failed; retrying at the next interval'))
      },
      60 * 60 * 1000,
    )
    timer.unref()
    return () => clearInterval(timer)
  }
}
