import type { IncomingMessage, ServerResponse } from 'node:http'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityModelAccessError } from '../domain/community-model.js'
import type { MemberNativePluginHistory } from '../ports/native-plugin-history.js'
import type { CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import { readCommunityJson } from './community-request.js'
import { handleCommunityFailure, sendCommunityJson } from './community-errors.js'

/** A member token requests observation; it never supplies bundle facts or installation authorization. */
export function createNativePluginHistoryGateway(
  authorization: Pick<CommunityModelAuthorization, 'currentMember'>,
  history: Pick<MemberNativePluginHistory, 'request' | 'archiveReserved'>,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') {
      sendCommunityJson(response, 405, { code: 'method-not-allowed' })
      return
    }
    const controller = new AbortController()
    const aborted = () => {
      if (!response.writableEnded) controller.abort()
    }
    response.once('close', aborted)
    try {
      const initial = await authorization.currentMember(request.headers['x-api-key'])
      const value = await readCommunityJson(request, 4096)
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new BusinessRuleError('invalid', 'Invalid native plugin history request', 'native-plugin-history-invalid')
      const input = value as Record<string, unknown>
      const archive = input.mode === 'archive'
      const fields = archive ? ['generation', 'mode', 'integrity'] : ['generation', 'mode']
      if (
        Object.keys(input).some(key => !fields.includes(key)) ||
        typeof input.generation !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,120}$/u.test(input.generation) ||
        (archive
          ? typeof input.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(input.integrity)
          : input.mode !== 'read' && input.mode !== 'refresh')
      )
        throw new BusinessRuleError('invalid', 'Invalid native plugin history request', 'native-plugin-history-invalid')
      const member = await authorization.currentMember(request.headers['x-api-key'])
      if (member.username !== initial.username || member.spaceId !== initial.spaceId) throw new CommunityModelAccessError('forbidden')
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
      const result =
        input.mode === 'archive'
          ? { reserved: await history.archiveReserved(member, input.generation, input.integrity as string, signal) }
          : { names: await history.request(member, input.generation, input.mode as 'read' | 'refresh', signal) }
      sendCommunityJson(response, 200, result)
    } catch (error) {
      if (error instanceof CommunityModelAccessError)
        sendCommunityJson(response, error.kind === 'unauthenticated' ? 401 : 403, {
          code: 'native-plugin-history-access',
          error: 'Native plugin history access is unavailable.',
        })
      else handleCommunityFailure(response, error, true)
    } finally {
      response.off('close', aborted)
    }
  }
}
