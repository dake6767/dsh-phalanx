import type { CommunityMcpGroup } from '../../src/domain/admin-contract'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityGrantList from './CommunityGrantList'

export default function CommunityGroupMcp({
  data,
  selected,
  onSelect,
  busy,
}: {
  data?: CommunityMcpGroup
  selected: readonly string[]
  onSelect: (names: readonly string[]) => void
  busy: boolean
}) {
  const { t } = usePlatformLanguage()
  if (!data) return <p role="status">{t('Loading…')}</p>
  return (
    <CommunityGrantList
      rows={data.services.map(service => ({ id: service.name, name: service.name }))}
      selected={selected}
      onChange={onSelect}
      busy={busy}
      addLabel={t('Add MCP services')}
      dialogTitle={t('Add MCP services')}
      emptyLabel={t(data.services.length ? 'No granted MCP services' : 'No MCP services yet')}
      noCandidatesLabel={t('No MCP services available to add')}
    />
  )
}
