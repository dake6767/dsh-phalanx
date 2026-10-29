import type { ContributionRows } from './contribution-rows.js'
import type { ContributionTransactionsPort } from './contribution-transactions.js'

/** Private intake reads rows; decisions own the complete database transaction. */
export interface ContributionPersistence {
  readonly rows: ContributionRows
  readonly actions: ContributionTransactionsPort
}
