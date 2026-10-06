import { request } from 'node:http'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunitySystemUpdateCheckResult, CommunitySystemUpdateStatus, CommunitySystemUpdateSubmission } from '../domain/admin-contract.js'
import { CommunitySystemUpdateUnavailableError, type CommunitySystemUpdatePort } from '../ports/community-system-update.js'

const unavailable = () => new CommunitySystemUpdateUnavailableError('System update service is unavailable. Reconnect to view the original operation. An operator can use the current installer for recovery.')

/** Sole Web transport to the fixed, independently running Linux root owner. */
export class UnixCommunitySystemUpdate implements CommunitySystemUpdatePort {
  constructor(private readonly socketPath = '/run/dsh-phalanx-updater/control.sock') {}
  status(operation?: string): Promise<CommunitySystemUpdateStatus> { return this.send({ action: 'status', ...(operation === undefined ? {} : { operation }) }) }
  check(): Promise<CommunitySystemUpdateCheckResult> { return this.send({ action: 'check' }) }
  prepare(version: string, manifestSha256: string): Promise<CommunitySystemUpdateSubmission> { return this.send({ action: 'prepare', version, manifestSha256 }) }
  apply(operation: string): Promise<CommunitySystemUpdateSubmission> { return this.send({ action: 'apply', operation }) }
  private send<T>(input: object): Promise<T> {
    const body = JSON.stringify(input)
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: Error, value?: T) => {
        if (settled) return
        settled = true; clearTimeout(deadline)
        if (error) reject(error); else resolve(value!)
      }
      const req = request({ socketPath: this.socketPath, path: '/control', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
        const chunks: Buffer[] = []; let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 128 * 1024) { finish(unavailable()); req.destroy(); return }
          chunks.push(chunk)
        })
        response.on('error', () => finish(unavailable()))
        response.on('aborted', () => finish(unavailable()))
        response.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: unknown }
            if (value === null || typeof value !== 'object' || Array.isArray(value)) { finish(unavailable()); return }
            if (response.statusCode !== 200) {
              const kind = response.statusCode === 400 ? 'invalid' : response.statusCode === 404 ? 'missing' : response.statusCode === 409 ? 'conflict' : undefined
              finish(kind ? new BusinessRuleError(kind, typeof value.error === 'string' ? value.error.slice(0, 2048) : 'System update request refused') : unavailable()); return
            }
            finish(undefined, value as T)
          } catch { finish(unavailable()) }
        })
      })
      // A bounded HTTP connection never owns or cancels the root transaction.
      const deadline = setTimeout(() => { finish(unavailable()); req.destroy() }, 60_000)
      req.on('error', () => finish(unavailable()))
      req.end(body)
    })
  }
}
