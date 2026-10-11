import { useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Switch } from '@heroui/react/switch';
import { Label } from '@heroui/react/label';
import type { CommunityExecutionView } from '../../src/domain/admin-contract';
import { communitySkillExecution, saveCommunitySkillExecution, reprepareCommunitySkillExecution } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import { useDraftGuard } from './useDraftGuard';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';

export default function CommunitySkillExecution({ name, onCloseGuard }: { name: string; onCloseGuard: (guard: ((action: () => void) => void) | undefined) => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [saved, setSaved] = useState<CommunityExecutionView>(), [enabled, setEnabled] = useState(false);
  const [command, setCommand] = useState(''), [variable, setVariable] = useState(''), [credential, setCredential] = useState('');
  const [prepare, setPrepare] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(false), [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);
  const reset = (value: CommunityExecutionView) => { setSaved(value); setEnabled(value.enabled); setCommand(value.commands[0]?.command ?? ''); setVariable(value.variables[0]?.name ?? ''); setCredential(''); setPrepare(value.prepare ?? ''); };
  useEffect(() => {
    const controller = new AbortController();
    void communitySkillExecution(name, controller.signal).then(value => { if (!controller.signal.aborted) { reset(value); setError(undefined); } }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [name, reload]);
  const dirty = !!saved && (enabled !== saved.enabled || command !== (saved.commands[0]?.command ?? '') || variable !== (saved.variables[0]?.name ?? '') || credential !== '' || prepare !== (saved.prepare ?? ''));
  const save = async () => {
    if (busy || !saved) return false;
    setBusy(true); setError(undefined); setNotice(false);
    try {
      const value = await saveCommunitySkillExecution(name, { enabled, commands: command ? [{ command, blocked: saved.commands[0]?.blocked ?? [] }, ...saved.commands.slice(1)] : [], variables: variable ? [{ name: variable, secret: true, ...(credential ? { value: credential } : {}) }, ...saved.variables.slice(1)] : [], ...(prepare ? { prepare } : {}) });
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
    try { const value = await reprepareCommunitySkillExecution(name); setSaved(current => current ? { ...current, preparation: value.preparation } : current); }
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
      <CommunityField label={t('Delegated command')} value={command} onChange={setCommand} disabled={busy} description={t('Enter a command name or a script path relative to this skill.')}/>
      <CommunityField label={t('Credential variable')} value={variable} onChange={setVariable} disabled={busy}/>
      <CommunityField label={t('Credential value')} value={credential} onChange={setCredential} disabled={busy} type="password" description={t(saved.variables[0]?.configured ? 'A credential is saved. Leave blank to keep it.' : 'Credentials are stored only by the platform and are never displayed.')}/>
      <CommunityField label={t('Preparation command (optional)')} value={prepare} onChange={setPrepare} disabled={busy} description={t('Install dependencies once in a separate container. Prepared files are read-only during execution.')}/>
      {saved.preparation ? <CommunityMessage role="status" status={saved.preparation.stage === 'failed' ? 'danger' : saved.preparation.stage === 'ready' ? 'success' : 'accent'} title={t(saved.preparation.stage === 'failed' ? 'Preparation failed' : saved.preparation.stage === 'ready' ? 'Dependencies ready' : 'Preparing dependencies…')}>
        <time dateTime={new Date(saved.preparation.updatedAt).toISOString()}>{new Date(saved.preparation.updatedAt).toLocaleString()}</time>
      </CommunityMessage> : null}
      {saved.preparation?.log ? <details><summary>{t('Preparation log')}</summary><pre className="plugin-preparation-log">{saved.preparation.log}</pre></details> : null}
      <div><Button variant="secondary" isDisabled={busy || dirty || !saved.enabled || saved.preparation?.stage === 'preparing'} onPress={() => { void reprepare(); }}>{t('Prepare again')}</Button></div>
      {notice && !dirty ? <CommunityMessage status="success" title={t('Execution settings saved.')}/> : null}
      <div><Button isDisabled={busy || !dirty} onPress={() => { void save(); }}>{t('Save execution settings')}</Button></div>
    </>}{guard.dialog}
  </section>;
}
