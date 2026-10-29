import { Checkbox } from '@heroui/react/checkbox'
import type { CommunityMcpGroup } from '../../src/domain/admin-contract'
import { usePlatformLanguage } from './CommunityLanguage'
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
    <section className="group-grants" aria-label={t('MCP grants')}>
      <div className="group-grants-intro">
        <h3>{t('MCP grants')}</h3>
        <p>{t('MCP changes take effect immediately. Tools update on the next agent request.')}</p>
        <p>{t('Administrator instances also require explicit group configuration.')}</p>
      </div>
      <div className="group-grants-list">
        {data.services.length ? (
          data.services.map(service => (
            <div className="group-grant-item" key={service.name}>
              <Checkbox
                isSelected={selected.includes(service.name)}
                isDisabled={busy}
                onChange={checked => onSelect(checked ? [...selected, service.name] : selected.filter(name => name !== service.name))}
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  {service.name}
                </Checkbox.Content>
              </Checkbox>
              <p className="text-sm text-muted">{service.description}</p>
            </div>
          ))
        ) : (
          <p>{t('No MCP services yet')}</p>
        )}
      </div>
    </section>
  )
}
