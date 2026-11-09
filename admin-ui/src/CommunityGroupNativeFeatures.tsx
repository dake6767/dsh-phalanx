import { Checkbox } from '@heroui/react/checkbox'
import type { CommunityNativeFeatureGroup } from '../../src/domain/admin-contract'
import { nativeFeatureCanBeDisabled } from '../../src/domain/native-features'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityGrantSection from './CommunityGrantSection'

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
    <>
      <div className="section-note native-feature-intro">
        <p>{t('Choose the native features available to this group, including administrators.')}</p>
        <p>{t('Applies the next time an instance starts. This is not security isolation; members may still use the CLI or edit their own configuration.')}</p>
      </div>
      {saved ? (
        <p role="status" className="section-note">
          {t('Saved. Restart running instances to apply these changes.')}
        </p>
      ) : null}
      {sections.map(section => (
        <CommunityGrantSection key={section.id} title={section.name[locale]}>
          <ul className="native-feature-list">
            {data.features
              .filter(feature => feature.section.id === section.id)
              .map(feature => {
                const checked = feature.availability.available ? !disabled.includes(feature.id) : feature.enabled
                const required = checked && feature.availability.available && !nativeFeatureCanBeDisabled(data.features, disabled, feature.id)
                return (
                  <li key={feature.id}>
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
                    {required ? <p className="native-feature-hint">{t('Keep at least one of these options enabled.')}</p> : null}
                    {!feature.availability.available ? <p className="native-feature-hint">{feature.availability.reason[locale]}</p> : null}
                  </li>
                )
              })}
          </ul>
        </CommunityGrantSection>
      ))}
    </>
  )
}
