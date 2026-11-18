import { useState } from 'react'
import { Button } from '@heroui/react/button'
import type { CatalogGalleryTags } from '../../src/domain/suite-catalog-tags'
import type { SuiteCatalogLocalized } from '../../src/domain/suite-catalog-document'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityField from './CommunityField'

const all = ':all'
const unclassified = ':unclassified'

export function useCatalogFilters<T extends { id: string; title: SuiteCatalogLocalized; description: SuiteCatalogLocalized }>(
  entries: readonly T[],
  kind: CatalogGalleryTags['assignments'][number]['kind'],
  metadata?: CatalogGalleryTags,
) {
  const { t, locale } = usePlatformLanguage()
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState(all)
  const entryIds = new Set(entries.map(entry => entry.id))
  const assignments = new Map(metadata?.assignments.filter(row => row.kind === kind && entryIds.has(row.id)).map(row => [row.id, row.tags]))
  const activeTags = new Set(entries.flatMap(entry => assignments.get(entry.id) ?? []))
  const definitions = new Map(metadata?.tags.map(tag => [tag.id, tag]))
  const options = [...activeTags].flatMap(id => definitions.get(id) ?? [])
  const tag = activeTags.has(selection) || (options.length && selection === unclassified) ? selection : all
  if (tag !== selection) setSelection(tag)
  const search = query.trim().toLocaleLowerCase(locale)
  const visible = entries.filter(entry => {
    const tags = assignments.get(entry.id)
    if (tag !== all && (tag === unclassified ? tags?.length : !tags?.includes(tag))) return false
    return [entry.title[locale], entry.description[locale], entry.id].some(text => text.toLocaleLowerCase(locale).includes(search))
  })
  const clear = () => {
    setQuery('')
    setSelection(all)
  }
  return {
    visible,
    controls: entries.length ? (
      <div className="catalog-gallery-filters">
        <CommunityField label={t('Search catalog')} value={query} onChange={setQuery} />
        {options.length ? (
          <div role="group" aria-label={t('Filter by tag')} className="catalog-tag-buttons">
            {[
              { id: all, label: t('All entries') },
              ...options.map(option => ({ id: option.id, label: option.label[locale] })),
              { id: unclassified, label: t('Unclassified') },
            ].map(({ id, label }) => (
              <Button key={id} size="sm" variant={id === tag ? 'primary' : 'outline'} aria-pressed={id === tag} onPress={() => setSelection(id)}>
                {label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    ) : null,
    empty:
      search || tag !== all ? (
        <div className="plugin-library-empty">
          <p role="status">{t('No matching catalog entries.')}</p>
          <Button variant="secondary" onPress={clear}>
            {t('Clear filters')}
          </Button>
        </div>
      ) : null,
  }
}
