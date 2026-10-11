import { useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Switch } from '@heroui/react/switch';
import { Label } from '@heroui/react/label';
import type { CommunityExecutionView } from '../../src/domain/admin-contract';
import { communitySkillExecution, saveCommunitySkillExecution } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import { useDraftGuard } from './useDraftGuard';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';

export default function CommunitySkillExecution({ name, onCloseGuard }: { name: string; onCloseGuard: (guard: ((action: () => void) => void) | undefined) => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [saved, setSaved] = useState<CommunityExecutionView>(), [enabled, setEnabled] = useState(false);
  const [command, setCommand] = useState(''), [variable, setVariable] = useState(''), [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(false), [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);
  const reset = (value: CommunityExecutionView) => { setSaved(value); setEnabled(value.enabled); setCommand(value.commands[0]?.command ?? ''); setVariable(value.variables[0]?.name ?? ''); setCredential(''); };
  useEffect(() => {
    const controller = new AbortController();
    void communitySkillExecution(name, controller.signal).then(value => { if (!controller.signal.aborted) { reset(value); setError(undefined); } }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [name, reload]);
  const dirty = !!saved && (enabled !== saved.enabled || command !== (saved.commands[0]?.command ?? '') || variable !== (saved.variables[0]?.name ?? '') || credential !== '');
  const save = async () => {
    if (busy || !saved) return false;
    setBusy(true); setError(undefined); setNotice(false);
    try {
      const value = await saveCommunitySkillExecution(name, { enabled, commands: command ? [{ command, blocked: saved.commands[0]?.blocked ?? [] }, ...saved.commands.slice(1)] : [], variables: variable ? [{ name: variable, secret: true, ...(credential ? { value: credential } : {}) }, ...saved.variables.slice(1)] : [], ...(saved.prepare ? { prepare: saved.prepare } : {}) });
      reset(value); setNotice(true); return true;
    } catch (failure) { setError(failure); return false; } finally { setBusy(false); }
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
      {notice && !dirty ? <CommunityMessage status="success" title={t('Execution settings saved.')}/> : null}
      <div><Button isDisabled={busy || !dirty} onPress={() => { void save(); }}>{t('Save execution settings')}</Button></div>
    </>}{guard.dialog}
  </section>;
}
