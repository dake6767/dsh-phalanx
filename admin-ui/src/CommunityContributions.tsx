import { contributionsChanged } from './useContributionCount';
import { Card } from '@heroui/react/card';
import { Button } from '@heroui/react/button';
import { Chip } from '@heroui/react/chip';
import { Switch } from '@heroui/react/switch';
import { Label } from '@heroui/react/label';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommunityContributionsView } from '../../src/domain/admin-contract';
import { reviewCommunityContribution, communityContributions, decideCommunityContribution } from './community-api';
import CommunityContributionDistribution from './CommunityContributionDistribution';
import CommunityExecutionFields, { executionDraft, executionInput } from './CommunityExecutionFields';
import CommunitySkillExecution from './CommunitySkillExecution';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';
import CommunityField from './CommunityField';
import CommunitySkillContent from './CommunitySkillContent';

export default function CommunityContributions({ onChanged }: { onChanged: () => void }) {
  const { t, locale, errorText } = usePlatformLanguage();
  const [data, setData] = useState<CommunityContributionsView>(), [error, setError] = useState<unknown>();
  const [selected, setSelected] = useState<string>(), [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [step, setStep] = useState<'review' | 'configuration' | 'distribution' | 'complete'>('review');
  const [review, setReview] = useState<Awaited<ReturnType<typeof reviewCommunityContribution>>>();
  const [draft, setDraft] = useState<ReturnType<typeof executionDraft>>({ commandRows: [], variableRows: [] });
  const [enabled, setEnabled] = useState(false), [prepare, setPrepare] = useState(''), [published, setPublished] = useState(false), [groups, setGroups] = useState<readonly string[]>([]);
  const [discarding, setDiscarding] = useState(false);
  const guard = useRef<((action: () => void) => void) | undefined>(undefined);
  const onGuard = useCallback((value: ((action: () => void) => void) | undefined) => { guard.current = value; }, []);
  const detail = data?.contributions.find(row => row.id === selected);
  const refresh = () => setRevision(value => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    void communityContributions(controller.signal).then(value => { if (!controller.signal.aborted) { setData(value); setError(undefined); } }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [revision]);
  const close = () => {
    if (step === 'complete' && guard.current) guard.current(() => setSelected(undefined));
    else if (step === 'configuration' || step === 'distribution') setDiscarding(true);
    else setSelected(undefined);
  };
  const startAdoption = async () => {
    if (!detail || busy) return; setBusy(true); setError(undefined);
    try {
      const value = await reviewCommunityContribution(detail.id, detail.revision);
      setReview(value); setDraft(executionDraft(value.execution ?? { enabled: false, commands: [], variables: [] })); setEnabled(value.execution?.enabled ?? false); setPrepare(value.execution?.prepare ?? ''); setGroups([]); setPublished(false); setStep('configuration');
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  const decide = async (action: 'adopt' | 'decline') => {
    if (!detail || busy) return; setBusy(true); setError(undefined);
    try {
      await decideCommunityContribution(detail.id, action, reason, detail.revision, review?.token, action === 'adopt' ? {
        execution: { enabled, ...executionInput(draft), ...(prepare ? { prepare } : {}) }, ...(published ? { published: true } : {}),
        groups: groups.map(id => ({ id, revision: review!.groups!.find(group => group.group.id === id)!.revision })),
      } : undefined);
      if (action === 'adopt') { setStep('complete'); setDraft({ commandRows: [], variableRows: [] }); }
      else setSelected(undefined);
      refresh(); onChanged(); window.dispatchEvent(new Event(contributionsChanged));
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  const status = (value: string) => t(value === 'pending' ? 'Pending contribution' : value === 'adopted' ? 'Adopted' : value === 'declined' ? 'Not adopted' : 'Withdrawn');
  const date = (value: number) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
  return <section className="panel plugin-library-panel" aria-label={t('Member contributions')}>
    <div className="panel-top panel-filter-header"><div><div className="panel-title-row"><h2>{t('Member contributions')}</h2><span className="panel-item-count">{data?.contributions.filter(row => row.status === 'pending').length ?? '—'}</span></div><p>{t('Review contributions before adding them to the library.')}</p></div><Button variant="secondary" onPress={refresh}>{t('Reload')}</Button></div>
    {error !== undefined && !detail ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {!data ? <p role="status">{t('Loading…')}</p> : !data.contributions.length ? <p className="empty-state">{t('No contributions yet')}</p> : <div className="plugin-card-grid">{data.contributions.map(row => <Card key={row.id} className="plugin-library-card"><Card.Header><div className="plugin-card-top"><Chip size="sm" variant="soft">{status(row.status)}</Chip></div><Card.Title>{row.name}</Card.Title><Card.Description>{row.declaration.purpose}</Card.Description></Card.Header><Card.Content><p>{row.contributor.username} · {date(row.submittedAt)}</p></Card.Content><Card.Footer><Button variant="secondary" onPress={() => { setReview(undefined); setStep('review'); setReason(''); setError(undefined); setSelected(row.id); }}>{t('Review contribution')}</Button></Card.Footer></Card>)}</div>}
    {detail ? <CommunityDialog drawer drawerClassName="plugin-drawer" eyebrow={t('Member contributions')} title={detail.name} busy={busy} onClose={close} footer={step === 'configuration' ? <><Button variant="secondary" isDisabled={busy} onPress={() => setStep('review')}>{t('Back to review')}</Button><Button isDisabled={busy} onPress={() => setStep('distribution')}>{t('Continue to distribution')}</Button></> : step === 'distribution' ? <><Button variant="secondary" isDisabled={busy} onPress={() => setStep('configuration')}>{t('Back to configuration')}</Button><Button isDisabled={busy} onPress={() => { void decide('adopt'); }}>{t('Confirm adoption')}</Button></> : step === 'complete' ? <Button onPress={close}>{t('Finish adoption')}</Button> : detail.status === 'pending' ? <><Button variant="secondary" isDisabled={busy} onPress={() => { void decide('decline'); }}>{t('Do not adopt')}</Button><Button isDisabled={busy} onPress={() => { void startAdoption(); }}>{t('Adopt contribution')}</Button></> : undefined}>
      {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
      <div className="plugin-card-top">{(['review', 'configuration', 'distribution'] as const).map((value, index) => <Chip key={value} size="sm" variant="soft" color={step === value ? 'accent' : 'default'}>{index + 1} · {t(value === 'review' ? 'Review' : value === 'configuration' ? 'Configuration' : 'Distribution')}</Chip>)}</div>
      {review && step !== 'review' && step !== 'complete' ? <CommunityMessage status="warning" title={t(review.replacing ? 'This replaces the current skill and retains its publication and grants.' : 'Adoption adds a platform copy without publishing or granting it.')}>{t('{managed} managed members · {selected} member selections', { managed: review.managedMembers, selected: review.selectedMembers })}</CommunityMessage> : null}
      {step === 'configuration' ? <section className="plugin-detail-section"><p>{t('Declared commands and variables are prefilled. Enter platform credentials; prepare dependencies after adoption.')}</p>
        <Switch isSelected={enabled} onChange={setEnabled} isDisabled={busy}><Switch.Content><Switch.Control><Switch.Thumb/></Switch.Control><Label>{t('Enable platform execution')}</Label></Switch.Content></Switch>
        <CommunityExecutionFields draft={draft} onChange={setDraft} busy={busy}/><CommunityField label={t('Preparation command (optional)')} value={prepare} onChange={setPrepare} disabled={busy}/>
        {detail.declaration.execution?.variables.map(variable => <p key={variable.name}><strong>{variable.name}</strong> · {variable.purpose} · {variable.application}</p>)}
      </section> : step === 'distribution' ? <CommunityContributionDistribution name={detail.name} groups={review?.groups ?? []} selected={groups} onSelected={setGroups} published={published} onPublished={setPublished} busy={busy}/> : step === 'complete' ? <><CommunityMessage status="success" title={t('Adopted')}/>{detail.reason ? <CommunityMessage status="warning" title={detail.reason}/> : null}<CommunitySkillExecution name={detail.name} onCloseGuard={onGuard}/></> : <>
        <p className="drawer-description">{detail.declaration.purpose}</p><p>{detail.contributor.username} · {date(detail.submittedAt)} · {status(detail.status)}</p>
        {detail.findings?.map((finding, index) => <CommunityMessage key={index} status="warning" title={finding.code}><p>{finding.path}</p><p>{finding.advice}</p><p>{t(detail.retainedWarnings ? 'The member chose to retain these warnings.' : 'Review this finding.')}</p></CommunityMessage>)}
        <CommunitySkillContent markdown={detail.markdown} files={detail.files}/>
        {detail.reason ? <p>{detail.reason}</p> : null}
        {detail.status === 'pending' ? <CommunityField label={t('Reason for not adopting (optional)')} value={reason} onChange={setReason}/> : null}
      </>}
    </CommunityDialog> : null}
    {discarding ? <CommunityDialog title={t('Discard contribution configuration?')} onClose={() => setDiscarding(false)} footer={<><Button variant="secondary" onPress={() => setDiscarding(false)}>{t('Continue editing')}</Button><Button variant="danger" onPress={() => { setDiscarding(false); setSelected(undefined); setDraft({ commandRows: [], variableRows: [] }); }}>{t('Discard changes')}</Button></>}><p>{t('This contribution has not been adopted. Closing discards the configuration you entered.')}</p></CommunityDialog> : null}
  </section>;
}
