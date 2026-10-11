import { useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityExecutionSettings } from '../../src/domain/admin-contract';
import { executionSettings, saveExecutionSettings } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';
import { useDraftGuard } from './useDraftGuard';

const fields = [['memberConcurrency', 'Concurrent calls per member'], ['platformConcurrency', 'Concurrent calls across platform'], ['timeoutSeconds', 'Execution timeout (seconds)'], ['memoryMiB', 'Memory per call (MiB)'], ['cpus', 'CPUs per call'], ['pids', 'Processes per call']] as const;
export default function CommunityExecutionSettingsPanel() {
  const { t, errorText } = usePlatformLanguage();
  const [saved, setSaved] = useState<CommunityExecutionSettings>(), [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [notice, setNotice] = useState(false), [reload, setReload] = useState(0);
  const reset = (value: CommunityExecutionSettings) => { setSaved(value); setDraft(Object.fromEntries(fields.map(([key]) => [key, String(value.limits[key])]))); };
  useEffect(() => { const controller = new AbortController(); void executionSettings(controller.signal).then(value => { if (!controller.signal.aborted) { reset(value); setError(undefined); } }).catch(failure => { if (!controller.signal.aborted) setError(failure); }); return () => controller.abort(); }, [reload]);
  const dirty = !!saved && fields.some(([key]) => draft[key] !== String(saved.limits[key]));
  const save = async () => {
    if (busy || !saved) return false;
    setBusy(true); setError(undefined); setNotice(false);
    try { reset(await saveExecutionSettings({ memberConcurrency: Number(draft.memberConcurrency), platformConcurrency: Number(draft.platformConcurrency), timeoutSeconds: Number(draft.timeoutSeconds), memoryMiB: Number(draft.memoryMiB), cpus: Number(draft.cpus), pids: Number(draft.pids) })); setNotice(true); return true; }
    catch (failure) { setError(failure); return false; } finally { setBusy(false); }
  };
  const guard = useDraftGuard(dirty, save, () => { if (saved) reset(saved); }, busy);
  return <section className="panel settings-panel" aria-label={t('Platform execution limits')}><div className="panel-top"><div><h2>{t('Platform execution limits')}</h2><p>{t('Limits apply to new calls. Commands accept completed input only, without a terminal.')}</p></div></div><div className="settings-panel-body provider-form-fields">
    {error ? <><CommunityMessage role="alert" status="danger" title={errorText(error)}/><Button variant="secondary" onPress={() => guard.request(() => setReload(value => value + 1))}>{t('Reload settings')}</Button></> : null}
    {saved?.isolated === false ? <CommunityMessage status="warning" title={t('Platform execution is not isolated. Development only.')}/> : null}
    {!saved ? <p role="status">{t('Loading…')}</p> : fields.map(([key, label]) => <CommunityField key={key} label={t(label)} value={draft[key] ?? ''} onChange={value => setDraft(current => ({ ...current, [key]: value }))} disabled={busy} pattern={key === 'cpus' ? '[0-9]+([.][0-9]+)?' : '[0-9]+'}/>)}
    {notice && !dirty ? <CommunityMessage status="success" title={t('Execution limits saved.')}/> : null}
    <div><Button isDisabled={busy || !dirty} onPress={() => { void save(); }}>{t('Save execution limits')}</Button></div>
  </div>{guard.dialog}</section>;
}
