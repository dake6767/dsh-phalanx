import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { effectiveUserDataRoot } from '../domain/storage-layout.js'
import { consumeBootstrapCredential, issueBootstrapCredential, readBootstrapCredential, verifyBootstrapCredential } from './bootstrap-credential.js'
import type { BootstrapCredentialPort } from '../ports/bootstrap-credential.js'
import { readPlatformDatabaseState } from './platform-database-inspection.js'
import { FilePlatformDatabaseConfig } from './platform-database-config.js'

/** Refuse accidental adoption of unrelated identity and account data. */
export function assertCommunityDataRoot(root: string, bootstrapped?: boolean): void {
  if (
    bootstrapped === false &&
    [effectiveUserDataRoot({ dataRoot: root }), join(root, 'users')].some(path => existsSync(path) && readdirSync(path).length > 0)
  ) {
    throw new Error('Community deployment requires its own data root; existing account data is not migrated')
  }
}

/** File-owned invitation. Startup logs may name its path, never its contents. */
export class CommunityBootstrapCredential implements BootstrapCredentialPort {
  constructor(
    private readonly root: string,
    private readonly complete: () => Promise<boolean>,
  ) {}
  async prepare(): Promise<void> {
    if (await this.complete()) consumeBootstrapCredential(this.root)
    else {
      assertCommunityDataRoot(this.root, false)
      if ((readBootstrapCredential(this.root)?.expiresAt ?? 0) <= Date.now()) issueBootstrapCredential(this.root)
    }
  }
  verify(value: string): boolean {
    return verifyBootstrapCredential(this.root, value)
  }
  consume(): void {
    consumeBootstrapCredential(this.root)
  }
}

/** Privileged operator output; never called by public HTTP or normal startup logs. */
export async function createBootstrapLink(root: string, origin: URL, renew: boolean, configFile = join(homedir(), 'keys', 'database.json')): Promise<string> {
  assertCommunityDataRoot(root)
  const saved = FilePlatformDatabaseConfig.open(configFile, root),
    complete = (await readPlatformDatabaseState(saved.connection)).complete
  assertCommunityDataRoot(root, complete)
  if (complete) return new URL('/admin', origin).href
  const current = readBootstrapCredential(root)
  const invitation = renew || current === undefined || current.expiresAt <= Date.now() ? issueBootstrapCredential(root) : current
  const link = new URL('/bootstrap', origin)
  link.hash = new URLSearchParams({ credential: invitation.credential }).toString()
  return link.href
}
