import type { ServerResponse } from 'node:http'
import { CommunityEnvironmentRecoveryError } from '../domain/community-environment.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAccountOperationError, CommunityAuthenticationError } from '../domain/community-account.js'
import type { CommunityApiErrorBody, CommunityEnvironmentResetFailure } from '../domain/admin-contract.js'
import { CommunityRuntimeUnavailableError } from '../ports/community-runtime.js'
import { CommunityRequestError } from './community-request.js'
import { sendText } from './http-response.js'

export function sendCommunityJson(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

export function handleCommunityFailure(response: ServerResponse, error: unknown, json: boolean): void {
  const status = error instanceof CommunityRequestError ? error.status
    : error instanceof CommunityAuthenticationError ? 401
      : error instanceof CommunityRuntimeUnavailableError || error instanceof CommunityAccountOperationError || error instanceof CommunityEnvironmentRecoveryError ? 503
        : error instanceof BusinessRuleError ? error.kind === 'invalid' ? 400 : error.kind === 'forbidden' ? 403 : error.kind === 'missing' ? 404 : 409 : 500
  // Unexpected transport/storage failures never disclose credentials or submitted values.
  const message = status === 500 ? 'Internal Server Error' : error instanceof Error ? error.message : 'Request failed'
  if (response.headersSent) { response.destroy(); return }
  if (json && error instanceof CommunityEnvironmentRecoveryError) {
    const body: CommunityEnvironmentResetFailure = { error: message, phase: error.phase, ...(error.backup === undefined ? {} : { backup: error.backup }) }
    sendCommunityJson(response, status, body); return
  }
  if (json) { const body: CommunityApiErrorBody = { error: message }; sendCommunityJson(response, status, body) }
  else sendText(response, status, message)
}
