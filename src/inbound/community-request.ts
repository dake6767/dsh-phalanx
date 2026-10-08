import type { IncomingMessage } from 'node:http'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActionRequest, CommunityCreateAccountRequest, CommunityErrorCode, CommunityErrorParams } from '../domain/admin-contract.js'

export class CommunityRequestError extends Error {
  constructor(readonly status: 400 | 403 | 413 | 415, message: string, readonly code: CommunityErrorCode, readonly params?: CommunityErrorParams) { super(message) }
}

export function assertCommunityOrigin(request: IncomingMessage, origin: URL): void {
  if (request.headers['sec-fetch-site'] === 'cross-site'
    || request.headers.origin !== undefined && request.headers.origin !== origin.origin) {
    throw new CommunityRequestError(403, 'Forbidden', 'origin-forbidden')
  }
}

export function communityAccountInput(value: unknown): CommunityCreateAccountRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BusinessRuleError('invalid', 'Invalid account request', 'account-request-invalid')
  const body = value as Record<string, unknown>
  if (Object.keys(body).some(key => !['username', 'email', 'password'].includes(key))
    || typeof body.username !== 'string' || typeof body.email !== 'string' || typeof body.password !== 'string') {
    throw new BusinessRuleError('invalid', 'Only username, email and password are accepted', 'account-fields-invalid')
  }
  return { username: body.username, email: body.email, password: body.password }
}

export function communityAccountActionInput(value: unknown): CommunityAccountActionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BusinessRuleError('invalid', 'Invalid account action', 'account-action-invalid')
  const body = value as Record<string, unknown>
  const fields: Record<CommunityAccountActionRequest['action'], string | undefined> = {
    'set-email': 'email', 'reset-password': 'password', 'set-disabled': 'disabled', 'set-admin': 'admin', delete: undefined,
  }
  if (typeof body.action !== 'string' || !Object.hasOwn(fields, body.action)) throw new BusinessRuleError('invalid', 'Unknown account action', 'account-action-unknown')
  const field = fields[body.action as CommunityAccountActionRequest['action']]
  if (Object.keys(body).some(key => key !== 'action' && key !== field)) throw new BusinessRuleError('invalid', 'Unexpected account action fields', 'account-action-fields-unexpected')
  if (body.action === 'set-email' && typeof body.email === 'string') return { action: body.action, email: body.email }
  if (body.action === 'delete') return { action: 'delete' }
  if (body.action === 'reset-password' && typeof body.password === 'string') return { action: body.action, password: body.password }
  if (body.action === 'set-disabled' && typeof body.disabled === 'boolean') return { action: body.action, disabled: body.disabled }
  if (body.action === 'set-admin' && typeof body.admin === 'boolean') return { action: body.action, admin: body.admin }
  throw new BusinessRuleError('invalid', 'Invalid account action fields', 'account-action-fields-invalid')
}

export async function readCommunityForm(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await read(request, 'application/x-www-form-urlencoded'))
}
export async function readCommunityJson(request: IncomingMessage, limit = 16 * 1024): Promise<unknown> {
  const text = await read(request, 'application/json', limit)
  try { return JSON.parse(text) as unknown }
  catch { throw new CommunityRequestError(400, 'Invalid JSON request', 'json-invalid') }
}

function read(request: IncomingMessage, type: string, limit = 16 * 1024): Promise<string> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== type) {
    throw new CommunityRequestError(415, 'Unsupported Media Type', 'media-type-unsupported')
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let oversized = false
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > limit) {
        if (!oversized) { oversized = true; chunks.length = 0; reject(new CommunityRequestError(413, 'Request body is too large', 'request-too-large')) }
      } else chunks.push(chunk)
    })
    request.once('end', () => { if (!oversized) resolve(Buffer.concat(chunks).toString('utf8')) })
    request.once('error', reject)
    request.once('aborted', () => { reject(new CommunityRequestError(400, 'Request was interrupted', 'request-interrupted')) })
  })
}
