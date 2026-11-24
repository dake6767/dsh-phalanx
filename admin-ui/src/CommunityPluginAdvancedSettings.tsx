import { useState, type ComponentProps } from 'react'
import CommunityPluginAccess from './CommunityPluginAccess'
import CommunityPluginUpstreams from './CommunityPluginUpstreams'
import { usePlatformLanguage } from './CommunityLanguage'

export default function CommunityPluginAdvancedSettings({ catalog, ...access }: ComponentProps<typeof CommunityPluginAccess> & { catalog: boolean }) {
  const { t } = usePlatformLanguage()
  const [visited, setVisited] = useState(false)
  const tools = (
    <>
      <CommunityPluginUpstreams packageName={access.packageName} mode={catalog ? 'advanced' : 'manual'} onChanged={access.onChanged} />
      <CommunityPluginAccess {...access} />
    </>
  )
  if (!catalog) return tools
  return (
    <details
      className="plugin-detail-section"
      onToggle={event => {
        if (event.currentTarget.open) setVisited(true)
      }}
    >
      <summary>{t('Advanced settings')}</summary>
      {visited ? tools : null}
    </details>
  )
}
