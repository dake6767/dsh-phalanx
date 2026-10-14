import { contributionsChanged } from './useContributionCount';
import { Card } from '@heroui/react/card';
import { useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Chip } from '@heroui/react/chip';
import type { CommunityContributionsView, CommunitySkillPreview } from '../../src/domain/admin-contract';
import { reviewCommunityContribution, communityContributions, decideCommunityContribution } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';
import CommunityField from './CommunityField';
import CommunitySkillContent from './CommunitySkillContent';

export default function CommunityContributions({ onChanged }: { onChanged: () => void }) {
  const { t, locale, errorText } = usePlatformLanguage();
  const [data, setData] = useState<CommunityContributionsView>(), [error, setError] = useState<unknown>();
  const [selected, setSelected] = useState<string>(), [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [review, setReview] = useState<CommunitySkillPreview>();
  const detail = data?.contributions.find(row => row.id === selected);
  const refresh = () => setRevision(value => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    void communityContributions(controller.signal).then(value => { if (!controller.signal.aborted) { setData(value); setError(undefined); } }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [revision]);
  const decide = async (action: 'adopt' | 'decline') => {
    if (!detail || busy) return;
    setBusy(true);
    try {
      if (action === 'adopt' && !review) { setReview(await reviewCommunityContribution(detail.id, detail.revision)); return; }
      await decideCommunityContribution(detail.id, action, reason, detail.revision, review?.token); setSelected(undefined); refresh(); onChanged(); window.dispatchEvent(new Event(contributionsChanged)); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  const status = (value: string) => t(value === 'pending' ? 'Pending contribution' : value === 'adopted' ? 'Adopted' : value === 'declined' ? 'Not adopted' : 'Withdrawn');
  const date = (value: number) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
  return <section className="panel plugin-library-panel" aria-label={t('Member contributions')}>
    <div className="panel-top panel-filter-header"><div><div className="panel-title-row"><h2>{t('Member contributions')}</h2><span className="panel-item-count">{data?.contributions.filter(row => row.status === 'pending').length ?? '—'}</span></div><p>{t('Review contributions before adding them to the library.')}</p></div><Button variant="secondary" onPress={refresh}>{t('Reload')}</Button></div>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {!data ? <p role="status">{t('Loading…')}</p> : !data.contributions.length ? <p className="empty-state">{t('No contributions yet')}</p> : <div className="plugin-card-grid">{data.contributions.map(row => <Card key={row.id} className="plugin-library-card"><Card.Header><div className="plugin-card-top"><Chip size="sm" variant="soft">{status(row.status)}</Chip></div><Card.Title>{row.name}</Card.Title><Card.Description>{row.declaration.purpose}</Card.Description></Card.Header><Card.Content><p>{row.contributor.username} · {date(row.submittedAt)}</p></Card.Content><Card.Footer><Button variant="secondary" onPress={() => { setReview(undefined); setReason(''); setSelected(row.id); }}>{t('Review contribution')}</Button></Card.Footer></Card>)}</div>}
    {detail ? <CommunityDialog drawer drawerClassName="plugin-drawer" eyebrow={t('Member contributions')} title={detail.name} busy={busy} onClose={() => setSelected(undefined)} footer={detail.status === 'pending' ? <><Button variant="secondary" isDisabled={busy} onPress={() => { void decide('decline'); }}>{t('Do not adopt')}</Button><Button isDisabled={busy} onPress={() => { void decide('adopt'); }}>{t(review ? 'Confirm adoption' : 'Adopt contribution')}</Button></> : undefined}>
      <p className="drawer-description">{detail.declaration.purpose}</p><p>{detail.contributor.username} · {date(detail.submittedAt)} · {status(detail.status)}</p>
      {review ? <CommunityMessage status="warning" title={t(review.replacing ? 'This replaces the current skill and retains its publication and grants.' : 'Adoption adds a platform copy without publishing or granting it.')}>{t('{managed} managed members · {selected} member selections', { managed: review.managedMembers, selected: review.selectedMembers })}</CommunityMessage> : null}
      <CommunitySkillContent markdown={detail.markdown} files={detail.files}/>
      {detail.reason ? <p>{detail.reason}</p> : null}
      {detail.status === 'pending' ? <><CommunityField label={t('Reason for not adopting (optional)')} value={reason} onChange={setReason}/></> : null}
    </CommunityDialog> : null}
  </section>;
}
