import { useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Chip } from '@heroui/react/chip';
import { TextField } from '@heroui/react/textfield';
import { TextArea } from '@heroui/react/textarea';
import { Label } from '@heroui/react/label';
import type { CommunityPluginAccessInput, CommunityPluginAccessView } from '../../src/domain/admin-contract';
import { communityPluginAccess, saveCommunityPluginAccess } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';
import { useDraftGuard } from './useDraftGuard';

export default function CommunityPluginAccess({ packageName, onChanged, onCloseGuard }: { packageName: string; onChanged: () => void; onCloseGuard: (guard: ((action: () => void) => void) | undefined) => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [saved, setSaved] = useState<CommunityPluginAccessView>();
  const [environment, setEnvironment] = useState<CommunityPluginAccessInput['environment']>([]);
  const [entriesYaml, setEntriesYaml] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void communityPluginAccess(packageName, controller.signal).then(value => {
      if (!controller.signal.aborted) { setSaved(value); setEnvironment(value.environment); setEntriesYaml(value.entriesYaml); setError(undefined); }
    }).catch(error => { if (!controller.signal.aborted) setError(error); });
    return () => controller.abort();
  }, [packageName, reload]);
  const dirty = !!saved && (entriesYaml !== saved.entriesYaml || JSON.stringify(environment) !== JSON.stringify(saved.environment));
  const save = async () => {
    if (busy || !saved) return false;
    setBusy(true); setError(undefined);
    try { const value = await saveCommunityPluginAccess(packageName, { environment, entriesYaml }); setSaved(value); setEnvironment(value.environment); setEntriesYaml(value.entriesYaml); setNotice(true); onChanged(); return true; }
    catch (error) { setError(error); return false; } finally { setBusy(false); }
  };
  const guard = useDraftGuard(dirty, save, () => { setEnvironment(saved?.environment ?? []); setEntriesYaml(saved?.entriesYaml ?? ''); }, busy);
  useEffect(() => { onCloseGuard(guard.request); return () => onCloseGuard(undefined); }, [onCloseGuard, guard.request]);
  const update = (index: number, field: 'name' | 'value', value: string) => { setNotice(false); setEnvironment(rows => rows.map((row, i) => i === index ? { ...row, [field]: value } : row)); };
  return <section className="page-stack" aria-label={t('Access templates')}>
    <h4>{t('Access templates')}</h4>
    {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {!saved ? <><p role="status">{t('Loading…')}</p><Button variant="secondary" onPress={() => setReload(value => value + 1)}>{t('Reload plugins')}</Button></> : <>
      <Chip size="sm" variant="soft">{t(saved.configured ? 'Access configured' : 'Access not configured')}</Chip>
      {saved.invalidEntryIds.length ? <CommunityMessage status="warning" title={t('Missing entry IDs: {ids}', { ids: saved.invalidEntryIds.join(', ') })}/> : null}
      <p>{t('Use {upstream:name} for the forwarding address and {access-token} for the member token. Keep platform credentials in upstream settings.')}</p>
      <h5>{t('Plugin environment variables')}</h5>
      {environment.map((row, index) => <div className="page-stack" key={index}>
        <CommunityField label={t('Environment name')} value={row.name} disabled={busy} onChange={value => update(index, 'name', value)}/>
        <CommunityField label={t('Environment value')} value={row.value} disabled={busy} onChange={value => update(index, 'value', value)}/>
        <Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => setEnvironment(rows => rows.filter((_, i) => i !== index))}>{t('Remove variable')}</Button>
      </div>)}
      <Button variant="secondary" isDisabled={busy} onPress={() => setEnvironment(rows => [...rows, { name: '', value: '' }])}>{t('Add variable')}</Button>
      <p>{t('Platform runtime variables are reserved. Each environment name can belong to only one plugin.')}</p>
      <TextField isDisabled={busy} value={entriesYaml} onChange={value => { setEntriesYaml(value); setNotice(false); }}><Label>{t('Entry configuration YAML')}</Label><TextArea rows={10}/></TextField>
      <p>{t('Available entry IDs: {ids}', { ids: saved.entryIds.join(', ') || '—' })}</p>
      <p>{t('Map entry IDs to configuration objects. Objects merge recursively; arrays and scalars replace existing values. YAML tags and expressions are not allowed.')}</p>
      {notice ? <CommunityMessage status="success" title={t('Access saved. Affected members must restart their instances.')}/> : null}
      <div><Button isDisabled={busy || !dirty} onPress={() => { void save(); }}>{t('Save access settings')}</Button></div>
    </>}{guard.dialog}
  </section>;
}
