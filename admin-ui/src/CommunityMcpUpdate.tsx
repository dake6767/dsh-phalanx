import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityMcpCatalogUpdatePreview, CommunityMcpSettings } from '../../src/domain/admin-contract';
import { communityMcpUpdatePreview, applyCommunityMcpUpdate } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';

export default function CommunityMcpUpdate({ service, onClose, onStarted }: { service: CommunityMcpSettings; onClose: () => void; onStarted: (rows: readonly CommunityMcpSettings[]) => void }) {
  const { t, errorText } = usePlatformLanguage(), id = useId();
  const [preview, setPreview] = useState<CommunityMcpCatalogUpdatePreview>(), [credential, setCredential] = useState(''), [error, setError] = useState<unknown>(), [busy, setBusy] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID()), pending = useRef(false);
  useEffect(() => { const controller = new AbortController(); void communityMcpUpdatePreview(service.name, controller.signal).then(setPreview).catch(failure => { if (!controller.signal.aborted) setError(failure); }); return () => controller.abort(); }, [service.name]);
  const submit = async () => {
    if (!preview || pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { const rows = await applyCommunityMcpUpdate({ name: service.name, version: preview.version, requestId, ...(credential ? { credential } : {}) }); setCredential(''); onStarted(rows); }
    catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  };
  const labels = { description: 'Description', url: 'Remote MCP address', run: 'Run location', headers: 'Request headers', query: 'Query parameters' } as const;
  return <CommunityDialog drawer eyebrow={t('MCP market')} title={t('Review preset update')} busy={busy} onClose={onClose} footer={<><Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t('Cancel')}</Button><Button type="submit" form={id} isDisabled={busy || !preview || (preview.credentialRequired && !credential.trim())}>{t('Validate and update')}</Button></>}>
    <p>{service.name}</p><p>{t('The current service remains available until the new preset passes preparation and connection testing.')}</p><p>{t('Your name, credentials, access settings and member choices are preserved.')}</p>
    {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {!preview ? <p role="status">{t('Loading…')}</p> : <form id={id} className="upstream-editor" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p>{t('Preset update {before} → {after}', { before: preview.currentVersion, after: preview.version })}</p>
      {preview.changes.map(change => <section className="page-stack" key={change.field}><h3>{t(labels[change.field as keyof typeof labels])}</h3><p>{t('Current preset')}</p><pre className="plugin-preparation-log">{change.before}</pre><p>{t('New preset')}</p><pre className="plugin-preparation-log">{change.after}</pre></section>)}
      {preview.credentialRequired ? <CommunityField label={t('Platform credential')} type="password" value={credential} onChange={setCredential} required disabled={busy} autoComplete="new-password"/> : null}
    </form>}
  </CommunityDialog>;
}
