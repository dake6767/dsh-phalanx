import type { PluginPreinstallPlan } from '../domain/plugin-preinstall.js'

/** Startup captures checked bytes before any background installation is admitted. */
export interface PluginPreinstallPlanningPort {
  plan(username: string, installed: readonly string[]): Promise<PluginPreinstallPlan | undefined>
}

/** Both administrator and member reset enter these hooks inside the stopped-carrier fence. */
export interface PluginPreinstallResetPort {
  beforeReset(spaceId: string): Promise<void>
  afterReset(spaceId: string): Promise<void>
}
