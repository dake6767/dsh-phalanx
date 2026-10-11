import { useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { Chip } from '@heroui/react/chip';
import type { CommunitySkillPackLibrary } from '../../src/domain/admin-contract';
import { communitySkillPacks, skillSynchronizationEvent } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityIcon from './CommunityIcon';
import CommunityMessage from './CommunityMessage';
import CommunitySkillPackEditor from './CommunitySkillPackEditor';

export default function CommunitySkillPacks() {
  const { t, errorText } = usePlatformLanguage();
  const [data, setData] = useState<CommunitySkillPackLibrary>(), [error, setError] = useState<unknown>(), [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string>();
  useEffect(() => { const changed = () => setRevision(value => value + 1); window.addEventListener(skillSynchronizationEvent, changed); return () => window.removeEventListener(skillSynchronizationEvent, changed); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void communitySkillPacks(controller.signal).then(value => { if (!controller.signal.aborted) { setData(value); setError(undefined); } }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [revision]);
  return <section className="panel plugin-library-panel" aria-label={t('Skill packs')}>
    <div className="panel-top panel-filter-header"><div><div className="panel-title-row"><h2>{t('Skill packs')}</h2><span className="panel-item-count">{data?.packs.length ?? '—'}</span></div><p>{t('Combine library skills and optional instructions for a shared workflow.')}</p></div><Button onPress={() => setSelected('')}><CommunityIcon name="plus" size={16}/>{t('Create skill pack')}</Button></div>
    {error ? <><CommunityMessage role="alert" status="danger" title={errorText(error)}/><Button variant="secondary" onPress={() => setRevision(value => value + 1)}>{t('Reload skills')}</Button></> : null}
    {!data ? <p role="status" className="table-empty">{t('Loading…')}</p> : !data.packs.length ? <Card variant="transparent" className="plugin-library-empty"><Card.Header><Card.Title>{t('No skill packs yet')}</Card.Title><Card.Description>{t('Combine library skills and optional instructions for a shared workflow.')}</Card.Description></Card.Header></Card> : <div className="plugin-card-grid">{data.packs.map(pack => <Card key={pack.name} className="plugin-library-card">
      <Card.Header><div className="plugin-card-top"><span className="plugin-card-icon"><CommunityIcon name="skills" size={20}/></span><Chip variant="soft" size="sm" color={pack.published ? 'success' : 'default'}>{t(pack.published ? 'Published' : 'Not published')}</Chip></div><Card.Title>{pack.name}</Card.Title><Card.Description className="line-clamp-3">{pack.description}</Card.Description></Card.Header>
      <Card.Content><p>{pack.empty ? t('Empty pack — hidden from members') : t('{count} skills', { count: pack.skills.length })}</p><div className="flex flex-wrap gap-2">{pack.skills.map(name => <Chip key={name} size="sm" variant="soft">{name}</Chip>)}</div>{pack.conflict ? <CommunityMessage status="warning" title={t('Conflicts with a bundled runtime skill. Distribution is paused.')}/> : null}</Card.Content>
      <Card.Footer><span className="plugin-details-label" aria-hidden="true">{t('Skill pack details')}<CommunityIcon name="chevron" size={14}/></span><Button variant="tertiary" size="sm" className="plugin-details-action" aria-label={t('View skill pack {name}', { name: pack.name })} onPress={() => setSelected(pack.name)}/></Card.Footer>
    </Card>)}</div>}
    <div className="panel-footer plugin-library-note"><CommunityIcon name="shield" size={16}/><span>{t('Pack changes apply to new sessions without restarting instances.')}</span></div>
    {selected !== undefined ? <CommunitySkillPackEditor name={selected} onClose={() => setSelected(undefined)} onSaved={() => { setSelected(undefined); setRevision(value => value + 1); }}/> : null}
  </section>;
}
