import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { consumeBootstrapCredential, issueBootstrapCredential, verifyBootstrapCredential } from './bootstrap-credential.js'
import type { BootstrapCredentialPort } from '../ports/bootstrap-credential.js'

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
    else issueBootstrapCredential(this.root)
  }
  verify(value: string): boolean { return verifyBootstrapCredential(this.root, value) }
  consume(): void { consumeBootstrapCredential(this.root) }
}
