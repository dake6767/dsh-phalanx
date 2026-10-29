import { Checkbox } from '@heroui/react/checkbox'
import type { CommunityContributionGroupView } from '../../src/domain/admin-contract'
import { usePlatformLanguage } from './CommunityLanguage'

export default function CommunityContributionDistribution({
  groups,
  selected,
  onSelected,
  published,
  onPublished,
  busy,
  sharing,
  confirmed,
  onConfirmed,
}: {
  name: string
  groups: readonly CommunityContributionGroupView[]
  selected: readonly string[]
  onSelected: (groups: readonly string[]) => void
  published: boolean
  onPublished: (published: boolean) => void
  busy: boolean
  sharing?: boolean
  confirmed?: boolean
  onConfirmed?: (confirmed: boolean) => void
}) {
  const { t } = usePlatformLanguage()
  return (
    <section className="plugin-detail-section">
      <p>{t('Publishing and group authorization are optional. Changes follow the existing synchronization and restart rules.')}</p>
      <Checkbox isSelected={published} onChange={onPublished} isDisabled={busy}>
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          {t('Publish to marketplace')}
        </Checkbox.Content>
      </Checkbox>
      {sharing && published ? (
        <>
          <p>{t('All members will use the platform credentials.')}</p>
          <Checkbox isSelected={confirmed} onChange={onConfirmed} isDisabled={busy}>
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              {t('Confirm platform credential sharing')}
            </Checkbox.Content>
          </Checkbox>
        </>
      ) : null}
      <h3>{t('Authorization group')}</h3>
      {groups.map(group => {
        const granted = group.granted
        return (
          <div className="group-grant-item" key={group.group.id}>
            <Checkbox
              isSelected={granted || selected.includes(group.group.id)}
              isDisabled={busy || granted || group.preinstalled}
              onChange={value => onSelected(value ? [...selected, group.group.id] : selected.filter(id => id !== group.group.id))}
            >
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                {group.group.name}
                {granted ? ` · ${t('Granted')}` : ''}
              </Checkbox.Content>
            </Checkbox>
            {group.preinstalled ? <p>{t('Configured for preinstallation in this group.')}</p> : null}
            <p>{t('{count} members in this group', { count: group.members })}</p>
          </div>
        )
      })}
      <p>{t('Existing publication and grants are retained when no new distribution choices are selected.')}</p>
    </section>
  )
}
