import { join } from 'node:path'

/** Frozen DSH web-profile filesystem layout and manifest shape. */
export const DSH_HOME_DIRECTORY = '.dsh'
export const DSH_PROFILES_DIRECTORY = 'profiles'
export const DSH_WEB_PROFILE = 'web'
export const DSH_ROOT_CONFIG = 'cordis.yml'
export const DSH_PATCH_CONFIG = 'cordis.patch.yml'
export const DSH_PLUGIN_CONFIG_PATCH = 'plugin.cordis.yml'
export const DSH_ENV_FILE = '.env'
export const DSH_PROFILE_MANIFEST = 'package.json'
export const DSH_PROFILE_LOCK = 'pnpm-lock.yaml'
export const DSH_PLUGIN_MANAGER = '.plugin-manager'
export const DSH_CONTAINER_HOME = '/dsh-phalanx/home'
export const DSH_CONTAINER_PROFILE = dshWebProfilePath(DSH_CONTAINER_HOME)

export function dshHomePath(home: string): string { return join(home, DSH_HOME_DIRECTORY) }
export function dshProfilesPath(home: string): string { return join(dshHomePath(home), DSH_PROFILES_DIRECTORY) }
export function dshWebProfilePath(home: string): string { return join(dshProfilesPath(home), DSH_WEB_PROFILE) }
