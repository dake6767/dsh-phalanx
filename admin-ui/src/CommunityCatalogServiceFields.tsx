import type { Dispatch, SetStateAction } from 'react'
import { Button } from '@heroui/react/button'
import type { CommunityCatalogServiceDefinition } from '../../src/domain/suite-contract'
import CommunityField from './CommunityField'
import CommunitySelect from './CommunitySelect'
import { usePlatformLanguage } from './CommunityLanguage'
import { hasServiceDraft, missingServiceFields, serviceDraftKey, serviceSlotKey } from './community-catalog-setup'

type ServiceDrafts = Record<string, Record<string, string>>

export default function CommunityCatalogServiceFields({
  definitions,
  drafts,
  onDrafts,
  choices,
  onChoices,
  disabled,
}: {
  definitions: readonly CommunityCatalogServiceDefinition[]
  drafts: ServiceDrafts
  onDrafts: Dispatch<SetStateAction<ServiceDrafts>>
  choices: Record<string, string>
  onChoices: Dispatch<SetStateAction<Record<string, string>>>
  disabled: boolean
}) {
  const { t, locale } = usePlatformLanguage()
  return (
    <>
      {definitions.map(owner =>
        owner.slots.map(slot => {
          const key = serviceSlotKey(owner, slot.id)
          const selected = slot.backends.find(backend => backend.id === choices[key]) ?? slot.backends[0]
          const backends = owner.kind === 'plugin' && selected ? [selected] : slot.backends
          const incompleteAlternatives =
            owner.kind === 'plugin'
              ? slot.backends.filter(backend => {
                  if (backend === selected) return false
                  const values = drafts[serviceDraftKey(owner, slot.id, backend.id)]
                  return values && hasServiceDraft(values) && missingServiceFields(backend.fields, values).length > 0
                })
              : []
          return (
            <section key={key} className="catalog-service-slot" aria-label={slot.label[locale]}>
              <h3>{slot.label[locale]}</h3>
              {owner.kind === 'plugin' && slot.backends.length > 1 && selected ? (
                <CommunitySelect
                  label={t('Interface')}
                  value={selected.id}
                  options={slot.backends.map(backend => ({ id: backend.id, label: backend.label[locale] }))}
                  onChange={id => onChoices(current => ({ ...current, [key]: id }))}
                  disabled={disabled}
                />
              ) : null}
              {incompleteAlternatives.length ? (
                <p role="status">
                  {t('Finish or skip configuration for {interfaces}.', {
                    interfaces: incompleteAlternatives.map(backend => backend.label[locale]).join(' · '),
                  })}
                </p>
              ) : null}
              {backends.map(backend => {
                const key = serviceDraftKey(owner, slot.id, backend.id)
                const values = drafts[key] ?? {}
                const started = owner.kind === 'plugin' && hasServiceDraft(values)
                const missing = started ? missingServiceFields(backend.fields, values) : []
                const form = (
                  <div className="page-stack" key={key}>
                    {backend.fields.map(field => (
                      <CommunityField
                        key={field.name}
                        label={field.label?.[locale] ?? field.name}
                        type={field.type === 'secret' ? 'password' : field.type}
                        autoComplete={field.type === 'secret' ? 'new-password' : 'off'}
                        value={values[field.name] ?? ''}
                        disabled={disabled}
                        description={[
                          field.label ? field.name : '',
                          field.required
                            ? t('Required field')
                            : field.requiredGroup
                              ? t('Fill one of {fields}', {
                                  fields: backend.fields
                                    .filter(other => other.requiredGroup === field.requiredGroup)
                                    .map(other => other.label?.[locale] ?? other.name)
                                    .join(' / '),
                                })
                              : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        onChange={value => onDrafts(current => ({ ...current, [key]: { ...current[key], [field.name]: value } }))}
                      />
                    ))}
                    {missing.length ? (
                      <p role="status">
                        {t('Fields to configure: {fields}', { fields: missing.map(field => field.label?.[locale] ?? field.name).join(' · ') })}
                      </p>
                    ) : null}
                    {started ? (
                      <Button size="sm" variant="tertiary" isDisabled={disabled} onPress={() => onDrafts(current => ({ ...current, [key]: {} }))}>
                        {t('Skip this configuration')}
                      </Button>
                    ) : null}
                  </div>
                )
                return owner.kind === 'plugin' ? (
                  form
                ) : (
                  <details key={key} className="catalog-service-backend">
                    <summary>{backend.label[locale]}</summary>
                    {form}
                  </details>
                )
              })}
            </section>
          )
        }),
      )}
    </>
  )
}
