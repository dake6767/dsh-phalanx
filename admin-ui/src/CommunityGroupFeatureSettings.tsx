import { Checkbox } from '@heroui/react/checkbox'
import { useId } from 'react'
import { nativeFeatureCanBeDisabled } from '../../src/domain/native-features'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityGrantSection from './CommunityGrantSection'
import type { useNativeFeatures } from './useNativeFeatures'

export default function CommunityGroupFeatureSettings({ settings, busy }: { settings: ReturnType<typeof useNativeFeatures>; busy: boolean }) {
  const { locale, t } = usePlatformLanguage()
  const heading = useId()
  const { data, disabled, setDisabled, showAppCenter, setShowAppCenter, saved } = settings
  if (!data) return <p role="status">{t('Loading…')}</p>
  const sections = [...new Map(data.features.map(feature => [feature.section.id, feature.section])).values()]
  return (
    <>
      <CommunityGrantSection
        title={t('Platform features')}
        description={t('Applies when members refresh their DSH page. Existing resources remain available.')}
      >
        <Checkbox isSelected={showAppCenter} isDisabled={busy} onChange={setShowAppCenter}>
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            {t('Show Platform App Center')}
          </Checkbox.Content>
        </Checkbox>
      </CommunityGrantSection>
      <section className="native-feature-settings" aria-labelledby={heading}>
        <div className="native-feature-intro">
          <h2 id={heading}>{t('DSH native features')}</h2>
          <p>{t('Choose the native features available to this group, including administrators.')}</p>
          <p>{t('Applies the next time an instance starts. This is not security isolation; members may still use the CLI or edit their own configuration.')}</p>
        </div>
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
                        onChange={enabled => setDisabled(enabled ? disabled.filter(id => id !== feature.id) : [...disabled, feature.id])}
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
      </section>
      {saved ? (
        <p role="status" className="section-note">
          {t(saved === 'native' ? 'Saved. Restart running instances to apply these changes.' : 'Feature settings saved.')}
        </p>
      ) : null}
    </>
  )
}
