import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { Chip } from '@heroui/react/chip';
import type { CommunityMcpCatalogEntry, CommunityMcpSettings } from '../../src/domain/admin-contract';
import { communityMcpCatalog, importCommunityMcp } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityField from './CommunityField';
import CommunityIcon from './CommunityIcon';
import CommunityMessage from './CommunityMessage';

export default function CommunityMcpCatalog({ rows, onImported }: { rows?: readonly CommunityMcpSettings[]; onImported: (rows: readonly CommunityMcpSettings[]) => void }) {
  const { t, locale, errorText } = usePlatformLanguage();
  const [entries, setEntries] = useState<readonly CommunityMcpCatalogEntry[]>(), [error, setError] = useState<unknown>(), [selected, setSelected] = useState<CommunityMcpCatalogEntry>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void communityMcpCatalog(controller.signal).then(setEntries).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [revision]);
  return <section className="panel plugin-library-panel" aria-label={t('MCP market')}>
    <div className="panel-top panel-filter-header"><div><div className="panel-title-row"><h2>{t('MCP market')}</h2><span className="panel-item-count">{entries?.length ?? '—'}</span></div><p>{t('Platform-maintained presets. Enter the required inputs to prepare and test a service.')}</p></div></div>
    {error ? <><CommunityMessage role="alert" status="danger" title={errorText(error)}/><Button variant="secondary" onPress={() => { setError(undefined); setRevision(value => value + 1); }}>{t('Reload MCP services')}</Button></> : null}
    {!entries ? <p role="status" className="table-empty">{t('Loading…')}</p> : <div className="plugin-card-grid">{entries.map(entry => {
      const count = rows?.filter(row => row.catalog?.id === entry.id).length ?? entry.imported;
      return <Card key={entry.id} className="plugin-library-card">
        <Card.Header><div className="plugin-card-top"><span className="plugin-card-icon" aria-hidden="true"><CommunityIcon name="plugins" size={20}/></span><Chip size="sm" variant="soft">{t(entry.location === 'remote' ? 'Remote service' : entry.location === 'shared' ? 'Shared run' : 'Member container run')}</Chip></div><Card.Title>{entry.title[locale]}</Card.Title><Card.Description>{entry.description[locale]}</Card.Description></Card.Header>
        <Card.Content><p>{t('Preset version {version}', { version: entry.version })}</p><p>{entry.credentialLabel?.[locale] ?? t('No credential required')}</p>{count ? <Chip size="sm" variant="soft">{t('{count} imported services', { count })}</Chip> : null}</Card.Content>
        <Card.Footer><span className="plugin-details-label" aria-hidden="true">{t('Preset details')}<CommunityIcon name="chevron" size={14}/></span><Button className="plugin-details-action" variant="tertiary" size="sm" aria-label={t('View preset {name}', { name: entry.title[locale] })} onPress={() => setSelected(entry)}/></Card.Footer>
      </Card>;
    })}</div>}
    <div className="panel-footer plugin-library-note"><CommunityIcon name="shield" size={16}/><span>{t('Adding a service does not grant access or publish it.')}</span></div>
    {selected ? <CatalogImport entry={selected} onClose={() => setSelected(undefined)} onImported={next => { onImported(next); setSelected(undefined); }}/>: null}
  </section>;
}
function CatalogImport({ entry, onClose, onImported }: { entry: CommunityMcpCatalogEntry; onClose: () => void; onImported: (rows: readonly CommunityMcpSettings[]) => void }) {
  const { t, locale, errorText } = usePlatformLanguage(), id = useId();
  const [name, setName] = useState(`p-${entry.id}`), [credential, setCredential] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const [requestId] = useState(() => crypto.randomUUID()), pending = useRef(false);
  const submit = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { const rows = await importCommunityMcp({ name, credential, presetId: entry.id, requestId }); setCredential(''); onImported(rows); }
    catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  };
  return <CommunityDialog drawer title={entry.title[locale]} eyebrow={t('MCP market')} busy={busy} onClose={onClose} footer={<><Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t('Cancel')}</Button><Button type="submit" form={id} isDisabled={busy || Boolean(entry.credentialLabel && !credential.trim())}>{t('Import and test')}</Button></>}>
    <p>{entry.description[locale]}</p><p>{t('Preset version {version}', { version: entry.version })}</p><p>{t('Connection settings are maintained by the platform.')}</p><a href={entry.documentation} target="_blank" rel="noreferrer">{t('Service documentation')}</a>
    {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <form id={id} className="upstream-editor" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <CommunityField label={t('MCP service name')} value={name} onChange={setName} required disabled={busy} autoFocus pattern="p-[A-Za-z0-9_-]{1,30}" description={t('Use p- followed by up to 30 letters, digits, underscores or hyphens.')}/>
      {entry.credentialLabel ? <CommunityField label={entry.credentialLabel[locale]} value={credential} onChange={setCredential} type="password" autoComplete="new-password" required disabled={busy}/> : <p>{t('No credential required')}</p>}
      <p>{t('Adding a service does not grant access or publish it.')}</p>
    </form>
  </CommunityDialog>;
}
