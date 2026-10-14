import { Checkbox } from '@heroui/react/checkbox';
import type { CommunitySkillGroupView } from '../../src/domain/admin-contract';
import { usePlatformLanguage } from './CommunityLanguage';

export default function CommunityContributionDistribution({ name, groups, selected, onSelected, published, onPublished, busy }: {
  name: string; groups: readonly CommunitySkillGroupView[]; selected: readonly string[]; onSelected: (groups: readonly string[]) => void;
  published: boolean; onPublished: (published: boolean) => void; busy: boolean;
}) {
  const { t } = usePlatformLanguage();
  return <section className="plugin-detail-section">
    <p>{t('Publishing and group authorization are optional. Changes follow the existing synchronization and restart rules.')}</p>
    <Checkbox isSelected={published} onChange={onPublished} isDisabled={busy}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{t('Publish to marketplace')}</Checkbox.Content></Checkbox>
    <h3>{t('Authorization group')}</h3>
    {groups.map(group => {
      const granted = group.skills.some(skill => skill.name === name && skill.granted);
      return <div className="group-grant-item" key={group.group.id}>
        <Checkbox isSelected={granted || selected.includes(group.group.id)} isDisabled={busy || granted} onChange={value => onSelected(value ? [...selected, group.group.id] : selected.filter(id => id !== group.group.id))}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{group.group.name}{granted ? ` · ${t('Granted')}` : ''}</Checkbox.Content></Checkbox>
        <p>{t('{count} members in this group', { count: group.members })}</p>
      </div>;
    })}
    <p>{t('Existing publication and grants are retained when no new distribution choices are selected.')}</p>
  </section>;
}
