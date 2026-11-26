import type { PlatformLocale } from './platform-language.js'
import { BusinessRuleError } from './business-error.js'

interface LocalizedPluginText {
  readonly title?: Readonly<Record<string, string>>
  readonly description?: Readonly<Record<string, string>>
}

export interface PluginDisplayMetadata extends LocalizedPluginText {
  readonly icon?: string
}

export interface PluginDisplay {
  readonly name?: string
  readonly description?: string
  readonly catalogDefaults?: LocalizedPluginText
}

export interface PluginDisplayFields {
  readonly packageName: string
  readonly title: string
  readonly description: string
  readonly meta?: PluginDisplayMetadata
  readonly display?: PluginDisplay
}

export interface PluginNameFields {
  readonly packageName: string
  readonly title: string
  readonly localizedTitles?: Readonly<Record<PlatformLocale, string>>
}

export type PluginDisplayOverride = Pick<PluginDisplay, 'name' | 'description'>

export function pluginDisplayOverride(value: unknown, previous: PluginDisplay | undefined): PluginDisplay | undefined {
  const invalid = () => new BusinessRuleError('invalid', 'Invalid plugin display information.', 'plugin-display-invalid')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const input = value as PluginDisplayOverride
  const fields = Object.keys(value)
  if (
    !fields.length ||
    fields.some(field => field !== 'name' && field !== 'description') ||
    (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 200)) ||
    (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 4000))
  )
    throw invalid()
  const name = input.name?.trim() ?? previous?.name
  const description = input.description?.trim() ?? previous?.description
  const catalogDefaults = previous?.catalogDefaults
  if (!name && !description && !catalogDefaults) return undefined
  return { ...(name ? { name } : {}), ...(description ? { description } : {}), ...(catalogDefaults ? { catalogDefaults } : {}) }
}

function localizedText(values: Readonly<Record<string, string>> | undefined, locale: PlatformLocale): string | undefined {
  const language = locale.toLowerCase()
  const exact = Object.entries(values ?? {}).find(([key, value]) => key.toLowerCase() === language && value.trim())?.[1]
  return exact ?? (language === 'zh-cn' ? values?.zh?.trim() || undefined : undefined)
}

function otherLanguage(values: Readonly<Record<string, string>> | undefined): string | undefined {
  if (!values) return undefined
  return (
    localizedText(values, 'en') ??
    Object.keys(values)
      .sort()
      .map(key => values[key]?.trim())
      .find(Boolean)
  )
}

/** Resolve the displayed title and description independently so one translation cannot hide the other field's fallback. */
export function resolvePluginDisplay(plugin: PluginDisplayFields, locale: PlatformLocale) {
  const { display, meta } = plugin
  const field = (key: 'title' | 'description', override: string | undefined, fallback: string) =>
    override?.trim() || localizedText(meta?.[key], locale) || localizedText(display?.catalogDefaults?.[key], locale) || otherLanguage(meta?.[key]) || fallback
  return {
    title: field('title', display?.name, plugin.title.trim() || plugin.packageName),
    description: field('description', display?.description, plugin.description.trim()),
    ...(meta?.icon ? { icon: meta.icon } : {}),
  }
}
