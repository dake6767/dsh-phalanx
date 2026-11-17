import type { SuiteCatalogDocumentEntry, SuiteCatalogLocalized } from './suite-catalog-document.js'

type GalleryKind = 'suite' | 'plugin' | 'mcp'

export interface CatalogGalleryTags {
  readonly tags: readonly { readonly id: string; readonly label: SuiteCatalogLocalized }[]
  readonly assignments: readonly { readonly kind: GalleryKind; readonly id: string; readonly tags: readonly string[] }[]
}

export function readCatalogGalleryTags(raw: unknown, entries: readonly SuiteCatalogDocumentEntry[]): CatalogGalleryTags | undefined {
  if (!hasFields(raw, ['tags', 'assignments']) || !Array.isArray(raw.tags) || !Array.isArray(raw.assignments)) return
  const tags: CatalogGalleryTags['tags'][number][] = []
  const tagIds = new Set<string>()
  for (const tag of raw.tags) {
    if (
      !hasFields(tag, ['id', 'label']) ||
      typeof tag.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(tag.id) ||
      tagIds.has(tag.id) ||
      !hasFields(tag.label, ['en', 'zh-CN']) ||
      !displayName(tag.label.en) ||
      !displayName(tag.label['zh-CN'])
    )
      return
    tagIds.add(tag.id)
    tags.push({ id: tag.id, label: { en: tag.label.en, 'zh-CN': tag.label['zh-CN'] } })
  }
  const identities = new Set(entries.map(entry => `${entry.kind}:${entry.id}`))
  const assigned = new Set<string>()
  const assignments: CatalogGalleryTags['assignments'][number][] = []
  for (const row of raw.assignments) {
    if (
      !hasFields(row, ['kind', 'id', 'tags']) ||
      (row.kind !== 'suite' && row.kind !== 'plugin' && row.kind !== 'mcp') ||
      typeof row.id !== 'string' ||
      !Array.isArray(row.tags) ||
      !row.tags.length ||
      row.tags.some(tag => typeof tag !== 'string' || !tagIds.has(tag)) ||
      new Set(row.tags).size !== row.tags.length
    )
      return
    const identity = `${row.kind}:${row.id}`
    if (!identities.has(identity) || assigned.has(identity)) return
    assigned.add(identity)
    assignments.push({ kind: row.kind, id: row.id, tags: row.tags })
  }
  return { tags, assignments }
}

function hasFields<T extends string>(value: unknown, fields: readonly T[]): value is Record<T, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}

function displayName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && Boolean(value.trim()) && !/[\p{Cc}\p{Cf}]/u.test(value)
}
