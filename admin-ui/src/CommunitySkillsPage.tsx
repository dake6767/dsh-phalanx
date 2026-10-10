import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { Chip } from '@heroui/react/chip';
import { Tabs } from '@heroui/react/tabs';
import type { CommunitySkillDetail, CommunitySkillView } from '../../src/domain/admin-contract';
import { changeCommunitySkill, communitySkillDetail, communitySkills } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityIcon from './CommunityIcon';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';
import CommunitySelect from './CommunitySelect';
import CommunitySkillContent from './CommunitySkillContent';
import CommunitySkillUploadDialog from './CommunitySkillUploadDialog';

export default function CommunitySkillsPage() {
  const { t, locale, errorText } = usePlatformLanguage();
  const [skills, setSkills] = useState<readonly CommunitySkillView[]>(), [filter, setFilter] = useState('all');
  const [revision, setRevision] = useState(0), [selected, setSelected] = useState<string>(), [detail, setDetail] = useState<CommunitySkillDetail>();
  const [uploading, setUploading] = useState(false), [removing, setRemoving] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(), [detailError, setDetailError] = useState<unknown>();
  const pending = useRef(false);
  const refresh = () => setRevision(value => value + 1);
  const visible = skills?.filter(skill => filter === 'all' || (filter === 'published' ? skill.published : !skill.published)) ?? [];
  useEffect(() => {
    const controller = new AbortController();
    void communitySkills(controller.signal).then(value => { if (!controller.signal.aborted) { setSkills(value); setError(undefined); } }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    const controller = new AbortController(); setDetail(undefined); setDetailError(undefined); setRemoving(false);
    if (selected) void communitySkillDetail(selected, controller.signal).then(value => { if (!controller.signal.aborted) setDetail(value); }).catch(failure => { if (!controller.signal.aborted) setDetailError(failure); });
    return () => controller.abort();
  }, [selected, revision]);
  const remove = async () => {
    if (!detail || pending.current) return;
    pending.current = true; setBusy(true);
    try { await changeCommunitySkill({ action: 'remove', name: detail.name, revision: detail.revision }); setSelected(undefined); refresh(); }
    catch (failure) { setDetailError(failure); setRemoving(false); }
    finally { pending.current = false; setBusy(false); }
  };
  const date = (time: number) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(time);
  return <div className="community-page">
    <section className="page-heading plugin-page-heading"><div><h1>{t('Skill library')}<span className="heading-dot" aria-hidden="true">.</span></h1><p>{t('Review and manage skills for your members.')}</p></div><div className="plugin-page-actions"><Button className="primary-action" onPress={() => setUploading(true)}><CommunityIcon name="plus" size={16}/>{t('Import skill')}</Button></div></section>
    {error !== undefined ? <><CommunityMessage role="alert" status="danger" title={errorText(error)}/><Button variant="secondary" onPress={refresh}>{t('Reload skills')}</Button></> : null}
    <section className="panel plugin-library-panel" aria-label={t('All skills')}>
      <div className="panel-top panel-filter-header"><div><div className="panel-title-row"><h2>{t('All skills')}</h2><span className="panel-item-count">{t('{count} skills', { count: skills ? visible.length : '—' })}</span></div><p>{t('Review skill contents, publication and affected members.')}</p></div><CommunitySelect className="panel-filter" hideLabel label={t('Filter by publication')} value={filter} onChange={setFilter} options={[{ id: 'all', label: t('All skills') }, { id: 'published', label: t('Published to marketplace') }, { id: 'unpublished', label: t('Not published') }]}/></div>
      {skills === undefined ? <p className="table-empty" role="status">{t('Loading…')}</p> : skills.length === 0 ? <Card className="plugin-library-empty" variant="transparent"><Card.Header><span className="plugin-card-icon" aria-hidden="true"><CommunityIcon name="skills" size={22}/></span><Card.Title>{t('No skills yet')}</Card.Title><Card.Description>{t('Import a ZIP to review its contents before sharing.')}</Card.Description></Card.Header></Card> : visible.length === 0 ? <Card className="plugin-library-empty" variant="transparent"><Card.Header><Card.Title>{t('No skills match this filter.')}</Card.Title></Card.Header><Card.Footer><Button variant="secondary" onPress={() => setFilter('all')}>{t('Show all skills')}</Button></Card.Footer></Card> : <div className="plugin-card-grid">{visible.map(skill => <Card key={skill.name} className="plugin-library-card">
        <Card.Header><div className="plugin-card-top"><span className="plugin-card-icon" aria-hidden="true"><CommunityIcon name="skills" size={20}/></span><Chip size="sm" variant="soft" color={skill.published ? 'success' : 'default'}>{t(skill.published ? 'Published' : 'Not published')}</Chip></div><Card.Title>{skill.name}</Card.Title><Card.Description>{skill.description}</Card.Description></Card.Header>
        <Card.Content><dl className="plugin-card-metadata"><div><dt>{t('Imported')}</dt><dd>{date(skill.importedAt)}</dd></div></dl><p>{t('{managed} managed members · {selected} member selections', { managed: skill.managedMembers, selected: skill.selectedMembers })}</p>{skill.conflict ? <CommunityMessage status="danger" title={t('Conflicts with a bundled runtime skill. Distribution is paused.')}/> : null}</Card.Content>
        <Card.Footer><span className="plugin-details-label" aria-hidden="true">{t('Skill details')}<CommunityIcon name="chevron" size={14}/></span><Button variant="tertiary" size="sm" onPress={() => setSelected(skill.name)} aria-label={t('View skill {name}', { name: skill.name })} className="plugin-details-action"/></Card.Footer>
      </Card>)}</div>}
      <div className="panel-footer plugin-library-note"><CommunityIcon name="shield" size={16}/><span>{t('Importing a skill does not grant it to ordinary groups or publish it to the marketplace.')}</span></div>
    </section>
    {uploading ? <CommunitySkillUploadDialog onClose={() => setUploading(false)} onAdded={() => { setUploading(false); refresh(); }}/> : null}
    {selected ? <CommunityDialog drawer drawerClassName="plugin-drawer" eyebrow={t('Skill details')} title={selected} closeLabel={t('Close skill details')} busy={busy} onClose={() => setSelected(undefined)}>
      {detailError !== undefined ? <><CommunityMessage role="alert" status="danger" title={errorText(detailError)}/><Button variant="secondary" onPress={refresh}>{t('Reload skills')}</Button></> : null}
      {!detail ? <p role="status">{t('Loading…')}</p> : <><p className="drawer-description">{detail.description}</p><div className="drawer-identity plugin-identity"><span className="plugin-card-icon" aria-hidden="true"><CommunityIcon name="skills" size={22}/></span><div><strong>{detail.name}</strong><span>{t('Imported')} · {date(detail.importedAt)}</span></div><Chip size="sm" variant="soft" color={detail.published ? 'success' : 'default'}>{t(detail.published ? 'Published' : 'Not published')}</Chip></div><p>{t('{managed} managed members · {selected} member selections', { managed: detail.managedMembers, selected: detail.selectedMembers })}</p>
        <Tabs className="plugin-detail-tabs" variant="secondary"><Tabs.ListContainer><Tabs.List aria-label={t('Skill details')}><Tabs.Tab id="contents">{t('Skill contents')}<Tabs.Indicator/></Tabs.Tab><Tabs.Tab id="maintenance">{t('Version management')}<Tabs.Indicator/></Tabs.Tab></Tabs.List></Tabs.ListContainer>
          <Tabs.Panel id="contents"><CommunitySkillContent markdown={detail.markdown} files={detail.files}/></Tabs.Panel>
          <Tabs.Panel id="maintenance"><section className="plugin-detail-section"><h2>{t('Version management')}</h2><p>{t('Import a ZIP with the same skill name to preview a replacement.')}</p><Button variant="secondary" onPress={() => { setSelected(undefined); setUploading(true); }}>{t('Import skill')}</Button><details className="plugin-integrity"><summary>{t('Content hash (sha256)')}</summary><code>{detail.hash}</code></details><Button variant="danger" onPress={() => setRemoving(true)}>{t('Remove skill')}</Button></section></Tabs.Panel>
        </Tabs></>}
      {removing && detail ? <CommunityDialog title={t('Remove skill')} busy={busy} onClose={() => setRemoving(false)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => setRemoving(false)}>{t('Cancel')}</Button><Button variant="danger" isDisabled={busy} onPress={() => { void remove(); }}>{t('Confirm removal')}</Button></>}><p>{detail.name}</p><p>{t('{managed} managed members · {selected} member selections', { managed: detail.managedMembers, selected: detail.selectedMembers })}</p><CommunityMessage status="warning" title={t('Changes apply to new sessions. Running tasks using this skill may fail.')}/></CommunityDialog> : null}
    </CommunityDialog> : null}
  </div>;
}
