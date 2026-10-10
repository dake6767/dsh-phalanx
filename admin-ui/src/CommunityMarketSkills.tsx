import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import type { CommunityMarketSkills as MarketData, CommunityMarketSkillDetail } from '../../src/domain/admin-contract';
import { marketSkills, marketSkillDetail, selectMarketSkill } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityMessage from './CommunityMessage';
import CommunityDialog from './CommunityDialog';
import CommunitySkillContent from './CommunitySkillContent';

export default function CommunityMarketSkills() {
  const { t, errorText } = usePlatformLanguage();
  const [data, setData] = useState<MarketData>(), [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState<string>(), [revision, setRevision] = useState(0), [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<CommunityMarketSkillDetail>(), [detailError, setDetailError] = useState<unknown>();
  const pending = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const next = await marketSkills(controller.signal); if (!controller.signal.aborted) { setData(next); setError(undefined); setSelected(current => next.skills.some(skill => skill.name === current) ? current : undefined); } }
      catch (failure) { if (!controller.signal.aborted) setError(failure); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => { void load(); }, 5000); }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [revision]);
  useEffect(() => {
    const controller = new AbortController(); setDetail(undefined); setDetailError(undefined);
    if (selected) void marketSkillDetail(selected, controller.signal).then(value => { if (!controller.signal.aborted) setDetail(value); }).catch(failure => { if (!controller.signal.aborted) setDetailError(failure); });
    return () => controller.abort();
  }, [selected, revision]);
  const select = async (name: string, action: 'install' | 'uninstall') => {
    if (pending.current) return;
    pending.current = true; setBusy(name); setError(undefined);
    try { await selectMarketSkill(name, action); }
    catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(undefined); setRevision(value => value + 1); }
  };
  return <section className="page-stack"><div className="page-title"><div><h2>{t('Skills')}</h2><p>{t('Skill selections apply to new sessions without restarting your instance.')}</p></div><Button variant="tertiary" onPress={() => setRevision(value => value + 1)}>{t('Reload skills')}</Button></div>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {data?.pending ? <CommunityMessage role="status" status="warning" title={t('Skill synchronization is incomplete. Ask an administrator to retry synchronization.')}/> : null}
    {!data ? <p role="status">{t('Loading…')}</p> : !data.skills.length ? <Card><Card.Header><Card.Title>{t('No published skills')}</Card.Title></Card.Header></Card> : <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{data.skills.map(skill => <Card key={skill.name}>
      <Card.Header><Card.Title className="break-words">{skill.name}</Card.Title><Card.Description className="line-clamp-3 break-words">{skill.description}</Card.Description></Card.Header>
      <Card.Content><p>{t(skill.status === 'overridden' ? 'Overridden by your own skill with the same name' : skill.status === 'managed' ? 'Installed (platform preinstalled)' : skill.status === 'selected' ? 'Installed (self-selected skill)' : 'Not installed')}</p>{skill.status === 'overridden' && skill.source === 'managed' ? <p>{t('Installed (platform preinstalled)')}</p> : null}<p>{t('Uninstall self-selected skills here. Your own skill files are unchanged.')}</p></Card.Content>
      <Card.Footer><Button variant="secondary" onPress={() => setSelected(skill.name)} aria-label={t('View skill {name}', { name: skill.name })}>{t('Skill details')}</Button><Button isDisabled={busy !== undefined || skill.source === 'managed'} onPress={() => { void select(skill.name, skill.source === 'selected' ? 'uninstall' : 'install'); }}>{t(busy === skill.name ? 'Saving…' : skill.source === 'managed' ? 'Installed' : skill.source === 'selected' ? 'Uninstall' : 'Install')}</Button></Card.Footer>
    </Card>)}</div>}
    {selected ? <CommunityDialog drawer drawerClassName="plugin-drawer" title={selected} eyebrow={t('Skill details')} closeLabel={t('Close skill details')} onClose={() => setSelected(undefined)}>{detailError !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(detailError)}/> : detail ? <><p className="drawer-description">{detail.description}</p><CommunitySkillContent markdown={detail.markdown} files={detail.files}/></> : <p role="status">{t('Loading…')}</p>}</CommunityDialog> : null}
  </section>;
}
