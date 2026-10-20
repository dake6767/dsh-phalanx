import { useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityExpertLibrary } from '../../src/domain/admin-contract';
import { communityExperts, publishCommunityExpert } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityExpertEditor from './CommunityExpertEditor';
import CommunityMessage from './CommunityMessage';

export default function CommunityExpertsPage() {
  const { t, errorText } = usePlatformLanguage();
  const [data, setData] = useState<CommunityExpertLibrary>(), [error, setError] = useState<unknown>(), [editing, setEditing] = useState<string>(), [revision, setRevision] = useState(0), [notice, setNotice] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const value = await communityExperts(controller.signal); if (!controller.signal.aborted) { setData(value); setError(undefined); } }
      catch (failure) { if (!controller.signal.aborted) setError(failure); }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 5000); }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [revision]);
  const [publishing, setPublishing] = useState<string>();
  const publish = async (id: string, published: boolean) => {
    if (!data || publishing) return;
    setPublishing(id); setError(undefined);
    try { setData(await publishCommunityExpert(id, published, data.revision)); setNotice(true); }
    catch (failure) { setError(failure); } finally { setPublishing(undefined); }
  };
  return <section className="library-page">
    <header className="page-heading"><div><p className="eyebrow">{t('Expert library')}</p><h1>{t('Experts')}</h1><p>{t('Assemble a persona and library capabilities into a focused working mode.')}</p></div><Button isDisabled={!data} onPress={() => setEditing('')}>{t('Create expert')}</Button></header>
    {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <CommunityMessage status="default" title={t('Members granted this expert can use all its entries and platform credentials, including entries not granted separately.')}/>
    {notice ? <CommunityMessage role="status" status="default" title={t('Expert changes take effect after members restart their instances.')}/> : null}
    {!data ? <p role="status">{t('Loading…')}</p> : data.experts.length === 0 ? <p>{t('No experts yet')}</p> : <div className="group-grants-list">{data.experts.map(expert => <article className="group-grant-item" key={expert.id}>
      <div><span aria-hidden="true">{expert.icon || '✦'}</span><h2>{expert.name}</h2><p>{expert.description}</p></div>
      <p>{t('{count} skills and skill packs', { count: expert.skills.length + expert.skillPacks.length })}</p>
      <p>{expert.modelLabel ?? t('Host default model')}</p>
      {expert.modelUnavailable ? <CommunityMessage status="warning" title={t('Expert model is unavailable. New conversations use the host default.')}/> : null}
      <p>{t(expert.published ? 'Published expert' : 'Unpublished expert')}</p>
      <Button variant="secondary" isDisabled={publishing !== undefined} aria-label={t(expert.published ? 'Unpublish expert {name}' : 'Publish expert {name}', { name: expert.name })} onPress={() => { void publish(expert.id, !expert.published); }}>{t(expert.published ? 'Unpublish expert' : 'Publish expert')}</Button>
      {expert.failures.map(failure => <CommunityMessage status="danger" key={failure.username} title={t('Expert load failed for {name}', { name: failure.username })}/>)}
      <Button variant="secondary" aria-label={t('Edit expert {name}', { name: expert.name })} onPress={() => setEditing(expert.id)}>{t('Edit expert')}</Button>
    </article>)}</div>}
    {editing !== undefined && data ? <CommunityExpertEditor key={editing} expert={data.experts.find(row => row.id === editing)} plugins={data.plugins} mcp={data.mcp} models={data.models} revision={data.revision} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); setNotice(true); setRevision(value => value + 1); }}/> : null}
  </section>;
}
