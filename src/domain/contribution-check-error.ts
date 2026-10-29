import { BusinessRuleError } from './business-error.js'
import type { ContributionFinding } from './member-contribution.js'
/** Safe diagnostics cross both tool and HTTP boundaries; never include matching source text. */
export class ContributionCheckError extends BusinessRuleError {
  constructor(readonly findings: readonly ContributionFinding[]) {
    super('invalid', 'Review the contribution findings and follow their advice before submitting.', 'contribution-check-failed')
  }
}
