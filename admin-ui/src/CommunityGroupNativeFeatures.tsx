import { Checkbox } from '@heroui/react/checkbox'
import type { CommunityNativeFeatureGroup } from '../../src/domain/admin-contract'
import { nativeFeatureCanBeDisabled } from '../../src/domain/native-features'
import { usePlatformLanguage } from './CommunityLanguage'

export default function CommunityGroupNativeFeatures({
  data,
  disabled,
  onChange,
  busy,
  saved,
}: {
  data?: CommunityNativeFeatureGroup
  disabled: readonly string[]
  onChange: (ids: readonly string[]) => void
  busy: boolean
  saved: boolean
}) {
  const { locale, t } = usePlatformLanguage()
  if (!data) return <p role="status">{t('Loading…')}</p>
  const sections = [...new Map(data.features.map(feature => [feature.section.id, feature.section])).values()]
  return (
    <section className="group-grants" aria-label={t('DSH native features')}>
      <div className="group-grants-intro">
        <h3>{t('DSH native features')}</h3>
        <p>{t('Choose the native features available to this group, including administrators.')}</p>
      </div>
      {saved ? <p role="status">{t('Saved. Restart running instances to apply these changes.')}</p> : null}
      {sections.map(section => (
        <section key={section.id} aria-label={section.name[locale]}>
          <h4>{section.name[locale]}</h4>
          <div className="group-grants-list">
            {data.features
              .filter(feature => feature.section.id === section.id)
              .map(feature => {
                const checked = feature.availability.available ? !disabled.includes(feature.id) : feature.enabled
                const required = checked && feature.availability.available && !nativeFeatureCanBeDisabled(data.features, disabled, feature.id)
                return (
                  <div className="group-grant-item" key={feature.id}>
                    <Checkbox
                      isSelected={checked}
                      isDisabled={busy || !feature.availability.available || required}
                      onChange={enabled => onChange(enabled ? disabled.filter(id => id !== feature.id) : [...disabled, feature.id])}
                    >
                      <Checkbox.Content>
                        <Checkbox.Control>
                          <Checkbox.Indicator />
                        </Checkbox.Control>
                        {feature.name[locale]}
                      </Checkbox.Content>
                    </Checkbox>
                    <p>{feature.description[locale]}</p>
                    {required ? <p>{t('Keep at least one of these options enabled.')}</p> : null}
                    {!feature.availability.available ? <p>{feature.availability.reason[locale]}</p> : null}
                  </div>
                )
              })}
          </div>
        </section>
      ))}
      <p>{t('Applies the next time an instance starts. This is not security isolation; members may still use the CLI or edit their own configuration.')}</p>
    </section>
  )
}
