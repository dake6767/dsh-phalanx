import { USAGE_REPORT_MAX_BYTES } from '../domain/usage-record.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityModelAccessError } from '../domain/community-model.js'
import type { UsageMember } from '../domain/usage-record.js'
import type { CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import type { UsagePolicy } from '../use-cases/usage-policy.js'
import { readCommunityJson } from './community-request.js'
import { handleCommunityFailure, sendCommunityJson } from './community-errors.js'

/** The token and current account determine identity; all submitted identity fields are ignored. */
export function createUsageReportGateway(authorization: CommunityModelAuthorization, usage: Pick<UsagePolicy, 'receive'>) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') { sendCommunityJson(response, 405, { code: 'method-not-allowed' }); return }
    try {
      authorization.authorize(request.headers['x-api-key'])
      const input = await readCommunityJson(request, USAGE_REPORT_MAX_BYTES)
      let member: UsageMember | undefined
      authorization.authorize(request.headers['x-api-key'], current => { member = current })
      usage.receive(member!, input)
      sendCommunityJson(response, 200, { received: true })
    } catch (error) {
      if (error instanceof CommunityModelAccessError) sendCommunityJson(response, error.kind === 'unauthenticated' ? 401 : 403, { code: 'usage-report-access', error: 'Skill report access is unavailable.' })
      else if (error instanceof BusinessRuleError && error.code === 'usage-report-rate') sendCommunityJson(response, 429, { code: error.code, error: error.message })
      else handleCommunityFailure(response, error, true)
    }
  }
}
