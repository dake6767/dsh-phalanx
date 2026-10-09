import { PluginPreparationError } from '../domain/plugin-library.js'
import { enErrorMessages } from '../domain/platform-error-messages.js'
import { CommunitySystemUpdateUnavailableError } from '../ports/community-system-update.js'
import type { ServerResponse } from 'node:http'
import { CommunityEnvironmentRecoveryError } from '../domain/community-environment.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAccountOperationError, CommunityAuthenticationError } from '../domain/community-account.js'
import type { CommunityApiErrorBody, CommunityEnvironmentResetFailure } from '../domain/admin-contract.js'
import { CommunityRuntimeUnavailableError } from '../ports/community-runtime.js'
import { CommunityRequestError } from './community-request.js'
import { sendHtml, sendText } from './http-response.js'

export function sendCommunityJson(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

export function handleCommunityFailure(response: ServerResponse, error: unknown, json: boolean, page?: (detail: CommunityApiErrorBody) => string): void {
  const status = error instanceof CommunityRequestError ? error.status
    : error instanceof CommunityAuthenticationError ? 401
      : error instanceof PluginPreparationError ? ['plugin-package-invalid', 'plugin-dependency-invalid', 'plugin-integrity-invalid'].includes(error.code) ? 400 : 503
        : error instanceof CommunitySystemUpdateUnavailableError || error instanceof CommunityRuntimeUnavailableError || error instanceof CommunityAccountOperationError || error instanceof CommunityEnvironmentRecoveryError ? 503
        : error instanceof BusinessRuleError ? error.kind === 'invalid' ? error.code === 'plugin-upload-too-large' ? 413 : 400 : error.kind === 'forbidden' ? 403 : error.kind === 'missing' ? 404 : 409 : 500
  // Unexpected transport/storage failures never disclose credentials or submitted values.
  const message = status === 500 ? 'Internal Server Error' : error instanceof PluginPreparationError ? enErrorMessages[error.code] : error instanceof Error ? error.message : 'Request failed'
  const code = error instanceof PluginPreparationError || error instanceof BusinessRuleError || error instanceof CommunityRequestError || error instanceof CommunityAuthenticationError
    || error instanceof CommunitySystemUpdateUnavailableError || error instanceof CommunityRuntimeUnavailableError
    || error instanceof CommunityAccountOperationError || error instanceof CommunityEnvironmentRecoveryError ? error.code : 'internal-error'
  const params = error instanceof BusinessRuleError || error instanceof CommunityRequestError
    || error instanceof CommunityAccountOperationError || error instanceof CommunityEnvironmentRecoveryError ? error.params : undefined
  const detail: CommunityApiErrorBody = { error: message, code, ...(params === undefined ? {} : { params }) }
  if (response.headersSent) { response.destroy(); return }
  if (json && error instanceof CommunityEnvironmentRecoveryError) {
    const body: CommunityEnvironmentResetFailure = { ...detail, phase: error.phase, ...(error.backup === undefined ? {} : { backup: error.backup }) }
    sendCommunityJson(response, status, body); return
  }
  if (json) sendCommunityJson(response, status, detail)
  else if (page) sendHtml(response, status, page(detail))
  else sendText(response, status, message)
}
