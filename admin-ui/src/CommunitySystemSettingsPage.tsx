import { featureVisible } from '../../src/domain/release-visibility'
import { useState } from 'react'
import { Tabs } from '@heroui/react/tabs'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunitySystemStatusPanel from './CommunitySystemStatusPanel'
import CommunitySystemUpdatePanel from './CommunitySystemUpdatePanel'
import CommunityDownloadSources from './CommunityDownloadSources'
import CommunityUsageSettings from './CommunityUsageSettings'
import CommunityInstanceResourceSettings from './CommunityInstanceResourceSettings'
import CommunityExecutionSettings from './CommunityExecutionSettings'

const tabs = ['overview', 'download-sources', 'resources', 'retention'] as const
type SettingsTab = (typeof tabs)[number]
// Legacy anchors keep landing on the panel they used to scroll to.
const initialTab = (): SettingsTab => {
  const requested = new URLSearchParams(location.search).get('tab')
  return (requested !== 'retention' || featureVisible('usage')) && tabs.includes(requested as SettingsTab) ? (requested as SettingsTab) : 'overview'
}

/** Panels stay mounted so update polling and unsaved drafts survive tab switches. */
export default function CommunitySystemSettingsPage() {
  const { t } = usePlatformLanguage()
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  return (
    <div className="system-settings-stack">
      <section className="page-heading">
        <div>
          <h1>{t('System settings')}</h1>
          <p>{t('Manage the installed version and recoverable system updates.')}</p>
        </div>
      </section>
      <Tabs
        className="skill-library-tabs library-workspace-tabs system-settings-tabs"
        selectedKey={tab}
        onSelectionChange={key => {
          setTab(key as SettingsTab)
          window.history.replaceState(null, '', key === 'overview' ? '/admin/settings' : `/admin/settings?tab=${String(key)}`)
        }}
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label={t('System settings')}>
            <Tabs.Tab id="overview">
              {t('Overview')}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="download-sources">
              {t('Download sources')}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="resources">
              {t('Resources and limits')}
              <Tabs.Indicator />
            </Tabs.Tab>
            {featureVisible('usage') ? (
              <Tabs.Tab id="retention">
                {t('Usage record retention')}
                <Tabs.Indicator />
              </Tabs.Tab>
            ) : null}
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="overview" shouldForceMount className="system-settings-panel">
          <CommunitySystemStatusPanel />
          <CommunitySystemUpdatePanel />
        </Tabs.Panel>
        <Tabs.Panel id="download-sources" shouldForceMount className="system-settings-panel">
          <CommunityDownloadSources />
        </Tabs.Panel>
        <Tabs.Panel id="resources" shouldForceMount className="system-settings-panel">
          <CommunityInstanceResourceSettings />
          <CommunityExecutionSettings />
        </Tabs.Panel>
        {featureVisible('usage') ? (
          <Tabs.Panel id="retention" shouldForceMount className="system-settings-panel">
            <CommunityUsageSettings />
          </Tabs.Panel>
        ) : null}
      </Tabs>
    </div>
  )
}
