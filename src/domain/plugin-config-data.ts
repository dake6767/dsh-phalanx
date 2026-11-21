import { pluginAccessObject } from './plugin-access.js'

/** JSON data for plugin settings. Cordis expressions are supplied only by the bundle. */
export function literalPluginAccess(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every(literalPluginAccess)) ||
    (pluginAccessObject(value) && Object.keys(value).every(key => key !== '__jsExpr') && Object.values(value).every(literalPluginAccess))
  )
}
