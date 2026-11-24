import type { Dispatch, SetStateAction } from 'react'
import { Button } from '@heroui/react/button'
import type { SuiteInstallImageSettings } from '../../src/domain/suite-catalog'
import CommunityField from './CommunityField'
import { usePlatformLanguage } from './CommunityLanguage'

export type CatalogImageDrafts = Record<string, Partial<SuiteInstallImageSettings>>

const imageFields = [
  { name: 'baseUrl', label: 'Upstream address', type: 'url' },
  { name: 'credential', label: 'API key', type: 'password' },
  { name: 'model', label: 'Model name', type: 'text' },
] as const

export function catalogImageGroups(names: readonly string[], imageDrafts: CatalogImageDrafts) {
  return names.map(name => {
    const draft = imageDrafts[name]
    const values = { name, baseUrl: draft?.baseUrl?.trim() ?? '', credential: draft?.credential ?? '', model: draft?.model?.trim() ?? '' }
    const started = imageFields.some(field => values[field.name].trim())
    const missing = started ? imageFields.filter(field => !values[field.name].trim()) : []
    return { name, values, started, missing }
  })
}

export default function CommunityCatalogImageSettings({
  groups,
  drafts,
  onDrafts,
  disabled,
}: {
  groups: ReturnType<typeof catalogImageGroups>
  drafts: CatalogImageDrafts
  onDrafts: Dispatch<SetStateAction<CatalogImageDrafts>>
  disabled: boolean
}) {
  const { t } = usePlatformLanguage()
  return (
    <>
      {groups.map(({ name, missing, started }) => (
        <section className="catalog-service-slot" key={name} aria-label={t('Image generation')}>
          <h3>{t('Image generation')}</h3>
          {imageFields.map(field => (
            <CommunityField
              key={field.name}
              label={t(field.label)}
              type={field.type}
              autoComplete={field.type === 'password' ? 'new-password' : 'off'}
              value={drafts[name]?.[field.name] ?? ''}
              disabled={disabled}
              onChange={value => onDrafts(current => ({ ...current, [name]: { ...current[name], [field.name]: value } }))}
            />
          ))}
          {missing.length ? <p role="status">{t('Fields to configure: {fields}', { fields: missing.map(field => t(field.label)).join(' · ') })}</p> : null}
          {started ? (
            <Button size="sm" variant="tertiary" isDisabled={disabled} onPress={() => onDrafts(current => ({ ...current, [name]: {} }))}>
              {t('Skip this configuration')}
            </Button>
          ) : null}
        </section>
      ))}
    </>
  )
}
