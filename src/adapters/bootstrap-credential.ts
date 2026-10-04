import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BOOTSTRAP_FILE = 'bootstrap-credential'
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000

/** One first-admin invitation: a deployment-local secret that the Web
 * bootstrap form exchanges for the administrator's username and password. */
export interface BootstrapCredential {
  readonly credential: string
  readonly expiresAt: number
}

/** File name of the credential inside the data root, mode 0600. */
export function bootstrapCredentialPath(directory: string): string {
  return join(directory, BOOTSTRAP_FILE)
}

/**
 * Explicitly issue (or re-issue) the credential. Ordinary service startup
 * preserves an outstanding invitation until it expires or is consumed.
 */
export function issueBootstrapCredential(directory: string, now: number = Date.now()): BootstrapCredential {
  const issued: BootstrapCredential = {
    credential: randomBytes(32).toString('base64url'),
    expiresAt: now + BOOTSTRAP_TTL_MS,
  }
  const path = bootstrapCredentialPath(directory)
  // Write-then-rename keeps a crash mid-write from stranding an unparseable
  // credential file (and therefore an unbootstrappable deployment).
  const staging = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`
  writeFileSync(staging, `${issued.credential} ${String(issued.expiresAt)}\n`, { mode: 0o600 })
  chmodSync(staging, 0o600)
  renameSync(staging, path)
  return issued
}

/** Read the outstanding credential, if one is written and parseable. */
export function readBootstrapCredential(directory: string): BootstrapCredential | undefined {
  const path = bootstrapCredentialPath(directory)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // Missing or raced with a concurrent consume: no outstanding credential.
    return undefined
  }
  const [credential, expiresAtText, extra] = text.trim().split(' ')
  if (credential === undefined || expiresAtText === undefined || extra !== undefined) return undefined
  const expiresAt = Number(expiresAtText)
  if (!Number.isSafeInteger(expiresAt) || credential.length === 0) return undefined
  return { credential, expiresAt }
}

/**
 * Timing-safe check of a candidate against the outstanding credential. An
 * expired or missing credential never verifies.
 */
export function verifyBootstrapCredential(directory: string, candidate: string, now: number = Date.now()): boolean {
  const outstanding = readBootstrapCredential(directory)
  if (outstanding === undefined || outstanding.expiresAt <= now) return false
  const actual = Buffer.from(candidate)
  const expected = Buffer.from(outstanding.credential)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Consume the credential after a successful bootstrap (idempotent). */
export function consumeBootstrapCredential(directory: string): void {
  rmSync(bootstrapCredentialPath(directory), { force: true })
}
