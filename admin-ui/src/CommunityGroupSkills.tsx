import { Checkbox } from '@heroui/react/checkbox';
import type { CommunitySkillGroupView } from '../../src/domain/admin-contract';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityMessage from './CommunityMessage';

export default function CommunityGroupSkills({ data, selected, onSelect, busy }: { data: CommunitySkillGroupView | undefined; selected: readonly string[]; onSelect: (names: readonly string[]) => void; busy: boolean }) {
  const { t } = usePlatformLanguage();
  if (!data) return <p role="status">{t('Loading…')}</p>;
  return <section className="group-grants" aria-label={t('Skill grants')}>
    <div className="group-grants-intro"><h3>{t('Skill grants')}</h3><p>{t('Skill grant changes apply to new sessions without restarting instances.')}</p>
      {data.group.kind === 'admin' ? <p>{t('All library skills are granted automatically to administrators.')}</p> : null}</div>
    <div className="group-grants-list">{data.skills.length ? data.skills.map(skill => <div className="group-grant-item" key={skill.name}>
      <Checkbox isSelected={selected.includes(skill.name)} isDisabled={busy || data.group.kind === 'admin' || skill.conflict && !skill.granted} onChange={checked => onSelect(checked ? [...selected, skill.name] : selected.filter(name => name !== skill.name))}>
        <Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{skill.name}</Checkbox.Content>
      </Checkbox><p className="text-sm text-muted">{skill.description}</p>
      {skill.conflict ? <CommunityMessage status="danger" title={t('Conflicts with a bundled runtime skill. Distribution is paused.')}/> : null}
    </div>) : <p>{t('No skills yet')}</p>}</div>
  </section>;
}
