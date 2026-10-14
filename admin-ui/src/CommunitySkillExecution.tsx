import CommunityExecutionTrial from './CommunityExecutionTrial';
import { useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Switch } from '@heroui/react/switch';
import { Label } from '@heroui/react/label';
import CommunityExecutionFields, { executionDraft, executionInput } from './CommunityExecutionFields';
import type { CommunityExecutionView } from '../../src/domain/admin-contract';
import { communitySkillExecution, saveCommunitySkillExecution, reprepareCommunitySkillExecution } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import { useDraftGuard } from './useDraftGuard';
import CommunityDependencyPicker from './CommunityDependencyPicker';
import CommunityMessage from './CommunityMessage';

export default function CommunitySkillExecution({ name, onCloseGuard }: { name: string; onCloseGuard: (guard: ((action: () => void) => void) | undefined) => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [saved, setSaved] = useState<CommunityExecutionView>(), [enabled, setEnabled] = useState(false);
  const [draft, setDraft] = useState<ReturnType<typeof executionDraft>>({ commandRows: [], variableRows: [] });
  const [dependencies, setDependencies] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(false), [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);
  const reset = (value: CommunityExecutionView) => { setSaved(value); setEnabled(value.enabled); setDraft(executionDraft(value)); setDependencies(value.runtimeDependencies ?? []); };
  useEffect(() => {
    const controller = new AbortController();
    void communitySkillExecution(name, controller.signal).then(value => { if (!controller.signal.aborted) { reset(value); setError(undefined); } }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [name, reload]);
  const dirty = !!saved && (enabled !== saved.enabled || JSON.stringify(executionInput(draft)) !== JSON.stringify(executionInput(executionDraft(saved))) || JSON.stringify(dependencies) !== JSON.stringify(saved.runtimeDependencies ?? []));
  const save = async () => {
    if (busy || !saved) return false;
    setBusy(true); setError(undefined); setNotice(false);
    try {
      const value = await saveCommunitySkillExecution(name, { enabled, ...executionInput(draft), runtimeDependencies: dependencies });
      reset(value); setNotice(true); return true;
    } catch (failure) { setError(failure); return false; } finally { setBusy(false); }
  };
  useEffect(() => {
    if (saved?.preparation?.stage !== 'preparing') return;
    const controller = new AbortController();
    const timer = setInterval(() => { void communitySkillExecution(name, controller.signal).then(value => {
      if (!controller.signal.aborted) setSaved(current => current ? { ...current, preparation: value.preparation } : current);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure); }); }, 1500);
    return () => { clearInterval(timer); controller.abort(); };
  }, [name, saved?.preparation?.stage]);
  const reprepare = async () => {
    setBusy(true); setError(undefined);
    try { const value = await reprepareCommunitySkillExecution(name); reset(value); }
    catch (failure) { setError(failure); } finally { setBusy(false); }
  };
  const guard = useDraftGuard(dirty, save, () => { if (saved) reset(saved); }, busy);
  useEffect(() => { onCloseGuard(guard.request); return () => onCloseGuard(undefined); }, [onCloseGuard, guard.request]);
  return <section className="plugin-access-template" aria-label={t('Platform execution')}>
    <div className="plugin-section-heading"><h3>{t('Platform execution')}</h3></div>
    <p>{t('Run delegated commands with platform credentials for members who own this skill.')}</p>
    {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {!saved ? <><p role="status">{t('Loading…')}</p><Button variant="secondary" onPress={() => setReload(value => value + 1)}>{t('Reload skills')}</Button></> : <>
      <Switch isSelected={enabled} onChange={setEnabled} isDisabled={busy}><Switch.Content><Switch.Control><Switch.Thumb/></Switch.Control><Label>{t('Enable platform execution')}</Label></Switch.Content></Switch>
      {saved.unavailableCommands?.length ? <CommunityMessage status="warning" title={t('Commands missing from this skill version')}><p>{saved.unavailableCommands.join(', ')}</p></CommunityMessage> : null}
      <p>{t('Suggested names come from static inspection. Review every command, variable and preparation step before saving.')}</p>
      <CommunityExecutionFields draft={draft} onChange={setDraft} busy={busy}/>
      <CommunityDependencyPicker key={JSON.stringify(saved.runtimeDependencies ?? [])} value={dependencies} onChange={setDependencies} disabled={busy}/>
      {saved.preparation ? <CommunityMessage role="status" status={saved.preparation.stage === 'failed' ? 'danger' : saved.preparation.stage === 'ready' ? 'success' : 'accent'} title={t(saved.preparation.stage === 'failed' ? 'Preparation failed' : saved.preparation.stage === 'ready' ? 'Dependencies ready' : 'Preparing dependencies…')}>
        <time dateTime={new Date(saved.preparation.updatedAt).toISOString()}>{new Date(saved.preparation.updatedAt).toLocaleString()}</time>
      </CommunityMessage> : null}
      {saved.preparation?.usingPrevious ? <CommunityMessage status="warning" title={t('Using the previous private installation while dependency migration needs attention.')}/> : null}
      {saved.preparation?.log ? <details><summary>{t('Preparation log')}</summary><pre className="plugin-preparation-log">{saved.preparation.log}</pre></details> : null}
      {saved.awaitingPreparation ? <div><Button variant="secondary" isDisabled={busy || dirty || !saved.enabled} onPress={() => { void reprepare(); }}>{t('Approve execution')}</Button></div> : null}
      {notice && !dirty ? <CommunityMessage status="success" title={t('Execution settings saved.')}/> : null}
      <div><Button isDisabled={busy || !dirty} onPress={() => { void save(); }}>{t('Save execution settings')}</Button></div>
      <CommunityExecutionTrial name={name} disabled={busy || dirty || !saved.enabled || (saved.preparation?.stage !== 'ready' && !saved.preparation?.usable)}/>
    </>}{guard.dialog}
  </section>;
}
