import { DSH_HOME_DIRECTORY, DSH_PROFILES_DIRECTORY, DSH_WEB_PROFILE, DSH_PATCH_CONFIG, DSH_ENV_FILE } from './profile-layout.js'

/** Official web profile bundles/plugins, home patch/env and legacy Settings import.
 * Other harness-home files (including session generations) are durable user data.
 * settings.yaml.imported is historical data and deliberately remains untouched.
 */
export const COMMUNITY_ENVIRONMENT_PATHS = [
  `${DSH_HOME_DIRECTORY}/${DSH_PROFILES_DIRECTORY}/${DSH_WEB_PROFILE}`,
  `${DSH_HOME_DIRECTORY}/${DSH_PATCH_CONFIG}`,
  `${DSH_HOME_DIRECTORY}/${DSH_ENV_FILE}`,
  `${DSH_HOME_DIRECTORY}/settings.yaml`,
] as const
