import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { consumeBootstrapCredential, issueBootstrapCredential, readBootstrapCredential, verifyBootstrapCredential } from './bootstrap-credential.js'
import type { BootstrapCredentialPort } from '../ports/bootstrap-credential.js'
import { CommunityAccountStore } from './community-account-store.js'

/** Refuse accidental legacy identity/data adoption; no enterprise database migration is promised. */
export function assertCommunityDataRoot(root: string): void {
  if (existsSync(join(root, 'accounts.db')) || !existsSync(join(root, 'community-accounts.db'))
    && existsSync(join(root, 'users')) && readdirSync(join(root, 'users')).length > 0) {
    throw new Error('Community deployment requires its own data root; existing account data is not migrated')
  }
}

/** File-owned invitation. Startup logs may name its path, never its contents. */
export class CommunityBootstrapCredential implements BootstrapCredentialPort {
  constructor(private readonly root: string, private readonly complete: () => boolean) {}
  prepare(): void {
    if (this.complete()) consumeBootstrapCredential(this.root)
    else if ((readBootstrapCredential(this.root)?.expiresAt ?? 0) <= Date.now()) issueBootstrapCredential(this.root)
  }
  verify(value: string): boolean { return verifyBootstrapCredential(this.root, value) }
  consume(): void { consumeBootstrapCredential(this.root) }
}

/** Privileged operator output; never called by public HTTP or normal startup logs. */
export function createBootstrapLink(root: string, origin: URL, renew: boolean): string {
  const database = join(root, 'community-accounts.db')
  if (!existsSync(database)) throw new Error('Start the installed platform before requesting an initialization link')
  const accounts = new CommunityAccountStore(database)
  try {
    if (accounts.bootstrapComplete()) return new URL('/admin', origin).href
    const current = readBootstrapCredential(root)
    const invitation = renew || current === undefined || current.expiresAt <= Date.now()
      ? issueBootstrapCredential(root) : current
    const link = new URL('/bootstrap', origin)
    link.hash = new URLSearchParams({ credential: invitation.credential }).toString()
    return link.href
  } finally { accounts.close() }
}
