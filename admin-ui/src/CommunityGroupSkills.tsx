import { Checkbox } from '@heroui/react/checkbox';
import type { CommunitySkillGroupView } from '../../src/domain/admin-contract';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityMessage from './CommunityMessage';

export default function CommunityGroupSkills({ data, selected, onSelect, busy, packs, onPacks }: { data: CommunitySkillGroupView | undefined; selected: readonly string[]; onSelect: (names: readonly string[]) => void; busy: boolean; packs: readonly string[]; onPacks: (names: readonly string[]) => void }) {
  const { t } = usePlatformLanguage();
  if (!data) return <p role="status">{t('Loading…')}</p>;
  return <section className="group-grants" aria-label={t('Skill grants')}>
    <div className="group-grants-intro"><h3>{t('Skill grants')}</h3><p>{t('Skill grant changes apply to new sessions without restarting instances.')}</p>
      {data.group.kind === 'admin' ? <p>{t('Administrator instances only receive explicitly configured skills and skill packs.')}</p> : null}</div>
    <div className="group-grants-list">{data.skills.length ? data.skills.map(skill => <div className="group-grant-item" key={skill.name}>
      <Checkbox isSelected={selected.includes(skill.name)} isDisabled={busy || skill.conflict && !skill.granted} onChange={checked => onSelect(checked ? [...selected, skill.name] : selected.filter(name => name !== skill.name))}>
        <Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{skill.name}</Checkbox.Content>
      </Checkbox><p className="text-sm text-muted">{skill.description}</p>
      {skill.conflict ? <CommunityMessage status="danger" title={t('Conflicts with a bundled runtime skill. Distribution is paused.')}/> : null}
    </div>) : <p>{t('No skills yet')}</p>}</div>
    <h3>{t('Skill pack grants')}</h3><p>{t('Pack changes apply to new sessions without restarting instances.')}</p>
    <div className="group-grants-list">{data.packs?.map(pack => <div className="group-grant-item" key={pack.name}><Checkbox isSelected={packs.includes(pack.name)} isDisabled={busy} onChange={checked => onPacks(checked ? [...packs, pack.name] : packs.filter(name => name !== pack.name))}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{pack.name}</Checkbox.Content></Checkbox><p className="text-sm text-muted">{pack.description}</p>{pack.empty ? <p>{t('Empty pack — hidden from members')}</p> : null}</div>)}</div>
  </section>;
}
