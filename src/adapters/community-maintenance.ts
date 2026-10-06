import { lstatSync } from 'node:fs'
import type { CommunityMaintenancePort } from '../ports/community-maintenance.js'

/** A root-owned durable marker survives both platform and updater restarts. */
export class FileCommunityMaintenance implements CommunityMaintenancePort {
  constructor(private readonly path?: string) {}
  closed(): boolean {
    if (this.path === undefined) return false
    try { lstatSync(this.path); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
  }
}
