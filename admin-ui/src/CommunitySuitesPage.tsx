import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { Checkbox } from '@heroui/react/checkbox';
import { Chip } from '@heroui/react/chip';
import CommunityIcon from './CommunityIcon';
import type { CommunityGroupView, CommunitySuiteCatalogEntryView, CommunitySuiteCatalogView, CommunitySuiteInstallPreview, CommunitySuiteInstallView, CommunitySuiteUninstallPreview } from '../../src/domain/admin-contract';
import { communityGroups, communitySuiteInstallPreview, communitySuites, communitySuiteUninstallPreview, installCommunitySuite, uninstallCommunitySuite } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';
import CommunitySelect from './CommunitySelect';
import { communityRequestId } from './community-request-id';
import type { PlatformMessageKey } from '../../src/domain/platform-copy';

const kindLabels = { 'runtime-dependency': 'Runtime dependencies', 'skill': 'Skills', 'skill-pack': 'Skill pack' } as const satisfies Record<string, PlatformMessageKey>;

export default function CommunitySuitesPage() {
  const { t, locale, errorText } = usePlatformLanguage();
  const [view, setView] = useState<CommunitySuiteCatalogView>();
  const [filter, setFilter] = useState('all');
  const [installing, setInstalling] = useState<CommunitySuiteCatalogEntryView>();
  const [uninstalling, setUninstalling] = useState<CommunitySuiteCatalogEntryView>();
  const [details, setDetails] = useState<CommunitySuiteCatalogEntryView>();
  const [error, setError] = useState<unknown>();
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision(value => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await communitySuites(controller.signal);
        if (controller.signal.aborted) return;
        setView(next); setError(undefined);
        if (next.installations.some(row => row.status === 'installing' || row.status === 'uninstalling')) timer = setTimeout(() => { void load(); }, 1000);
      } catch (failure) { if (!controller.signal.aborted) setError(failure); }
    };
    void load();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [revision]);
  const entries = view?.entries ?? [];
  const visible = entries.filter(entry => filter === 'all' || (filter === 'suites' ? entry.category === 'suite' : entry.category === 'dependency'));
  const installationOf = (entry: CommunitySuiteCatalogEntryView): CommunitySuiteInstallView | undefined => view?.installations.find(row => row.id === entry.id);
  const statusOf = (entry: CommunitySuiteCatalogEntryView): { label: string, tone: 'success' | 'warning' | 'danger' | 'default', busy: boolean } => {
    const installation = installationOf(entry);
    if (!installation) return { label: t('Not installed'), tone: 'default', busy: false };
    if (installation.status === 'installed') return { label: t(entry.updateAvailable ? 'Update available' : 'Installed'), tone: 'success', busy: false };
    if (installation.status === 'failed') return { label: t('Installation failed. You can retry.'), tone: 'danger', busy: false };
    return { label: t(installation.status === 'installing' ? 'Installing' : 'Uninstalling'), tone: 'warning', busy: true };
  };
  const stageClass = (tone: 'success' | 'warning' | 'danger' | 'default'): string => tone === 'danger' ? 'plugin-stage is-failed' : tone === 'success' ? 'plugin-stage is-available' : 'plugin-stage is-preparing';
  return <div className="community-page">
    <section className="page-heading plugin-page-heading"><div><h1>{t('Suite catalog')}</h1><p>{t('Install suites and shared runtime dependencies maintained by the platform.')}</p></div></section>
    {error !== undefined ? <><CommunityMessage role="alert" status="danger" title={errorText(error)}/><Button variant="secondary" onPress={refresh}>{t('Reload suites')}</Button></> : null}
    <section className="panel plugin-library-panel" aria-label={t('All catalog entries')}>
      <div className="panel-top panel-filter-header"><div><div className="panel-title-row"><h2>{t('All catalog entries')}</h2><span className="panel-item-count">{t('{count} entries', { count: view ? visible.length : '—' })}</span></div><p>{t('Review what each entry installs before you install it.')}</p></div>
        <CommunitySelect className="panel-filter" hideLabel label={t('Filter by category')} value={filter} onChange={setFilter} options={[{ id: 'all', label: t('All entries') }, { id: 'suites', label: t('Suites') }, { id: 'dependencies', label: t('Runtime dependencies') }]}/>
      </div>
      {view === undefined ? <p className="table-empty" role="status">{t('Loading…')}</p> : entries.length === 0 ? <Card className="plugin-library-empty" variant="transparent"><Card.Header><Card.Title>{t('The catalog is empty.')}</Card.Title><Card.Description>{t('Catalog entries ship with the platform and work offline.')}</Card.Description></Card.Header></Card> : visible.length === 0 ? <Card className="plugin-library-empty" variant="transparent"><Card.Header><Card.Title>{t('No entries match this filter.')}</Card.Title></Card.Header><Card.Footer><Button variant="secondary" onPress={() => setFilter('all')}>{t('All entries')}</Button></Card.Footer></Card> :
        <div className="plugin-card-grid">{visible.map(entry => <Card key={entry.id} className="plugin-library-card">
          <Card.Header>
            <div className="plugin-card-top"><span className="plugin-card-icon" aria-hidden="true"><CommunityIcon name="suites" size={20}/></span><Chip size="sm" variant="soft">{t(entry.category === 'suite' ? 'Suites' : 'Runtime dependencies')}</Chip></div>
            <Card.Title>{entry.title[locale]}</Card.Title>
            <Card.Description>{entry.description[locale]}</Card.Description>
          </Card.Header>
          <Card.Content>
            <dl className="plugin-card-metadata">
              <div><dt>{t('Source')}</dt><dd>{entry.source[locale]}</dd></div>
              <div><dt>{t('Version')}</dt><dd>{entry.version}</dd></div>
              {entry.commands.length ? <div><dt>{t('Commands')}</dt><dd>{entry.commands.join(', ')}</dd></div> : null}
              {entry.skills?.length ? <div><dt>{t('Skills')}</dt><dd>{t('{count} skills', { count: entry.skills.length })}</dd></div> : null}
            </dl>
            {!entry.available ? <p className="plugin-card-error">{t('Unavailable on this architecture')}</p> : null}
            <div className="plugin-card-status" role="status"><span className={stageClass(statusOf(entry).tone)}><span aria-hidden="true"/>{statusOf(entry).label}</span></div>
          </Card.Content>
          <Card.Footer>
            <span className="plugin-details-label" aria-hidden="true">{t('Suite entry details')}<CommunityIcon name="chevron" size={14}/></span>
            <Button variant="tertiary" size="sm" aria-label={t('View suite entry {name}', { name: entry.title[locale] })} className="plugin-details-action" onPress={() => setDetails(entry)}/>
            {installationOf(entry) === undefined ? <Button className="relative z-10" size="sm" variant="secondary" isDisabled={!entry.available} onPress={() => setInstalling(entry)}>{t('Install')}</Button>
              : installationOf(entry)?.status === 'failed' ? <Button className="relative z-10" size="sm" variant="secondary" onPress={() => setInstalling(entry)}>{t('Retry install')}</Button>
              : installationOf(entry)?.status === 'installed' ? <Button className="relative z-10" size="sm" variant="secondary" isDisabled={statusOf(entry).busy} onPress={() => setUninstalling(entry)}>{t('Uninstall')}</Button> : null}
          </Card.Footer>
        </Card>)}</div>}
      <div className="panel-footer plugin-library-note"><CommunityIcon name="shield" size={16}/><span>{t('Installing an entry does not grant it to groups or publish it.')}</span></div>
    </section>
    {installing ? <InstallDialog entry={installing} onClose={() => setInstalling(undefined)} onSubmitted={() => { setInstalling(undefined); refresh(); }}/> : null}
    {uninstalling ? <UninstallDialog entry={uninstalling} onClose={() => setUninstalling(undefined)} onSubmitted={() => { setUninstalling(undefined); refresh(); }}/> : null}
    {details ? <CommunityDialog drawer drawerClassName="plugin-drawer" eyebrow={t('Installation record')} title={details.title[locale]} closeLabel={t('Close suite entry details')} onClose={() => setDetails(undefined)}>
      <div className="drawer-identity plugin-identity">
        <span className="plugin-card-icon" aria-hidden="true"><CommunityIcon name="suites" size={22}/></span>
        <div><strong>{details.title[locale]}</strong><span>{details.source[locale]} · {t('Catalog version {version}', { version: details.version })}</span></div>
        <Chip size="sm" variant="soft" color={statusOf(details).tone}><span role="status">{statusOf(details).label}</span></Chip>
      </div>
      <div className="plugin-detail-sections">
        <section className="plugin-detail-section">
          <h2>{t('Installation record')}</h2>
          <dl className="plugin-card-metadata">
            <div><dt>{t('Version')}</dt><dd>{installationOf(details)?.version ?? details.version}</dd></div>
            {details.identity ? <div><dt>{t('Identity')}</dt><dd>{details.identity[locale]}</dd></div> : null}
            {details.packName ? <div><dt>{t('Skill pack')}</dt><dd>{details.packName}</dd></div> : null}
          </dl>
          <p>{t('Suite catalog entries install as read-only runtime dependencies.')}</p>
          {installationOf(details)?.entries.length ? <><h2>{t('Installed entries')}</h2><ul>{installationOf(details)!.entries.map(entry => <li key={entry.kind + ':' + entry.name}>{t(kindLabels[entry.kind])} · {entry.name}</li>)}</ul></> : null}
          {installationOf(details) ? <><h2>{t('Task log')}</h2><pre className="plugin-preparation-log">{installationOf(details)!.log}</pre></> : null}
        </section>
      </div>
    </CommunityDialog> : null}
  </div>;
}

function InstallDialog({ entry, onClose, onSubmitted }: { entry: CommunitySuiteCatalogEntryView; onClose: () => void; onSubmitted: () => void }) {
  const { t, locale, errorText } = usePlatformLanguage();
  const [preview, setPreview] = useState<CommunitySuiteInstallPreview>();
  const [groups, setGroups] = useState<readonly CommunityGroupView[]>();
  const [granted, setGranted] = useState<readonly string[]>([]);
  const [publish, setPublish] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [requestId] = useState(communityRequestId);
  const pending = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void communitySuiteInstallPreview(entry.id, controller.signal).then(setPreview).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    if (entry.category === 'suite') void communityGroups(controller.signal).then(setGroups).catch(() => {});
    return () => controller.abort();
  }, [entry.id, entry.category]);
  const ordinaryGroups = groups?.filter(group => group.kind !== 'admin') ?? [];
  const submit = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { await installCommunitySuite({ id: entry.id, requestId, ...(granted.length ? { groups: granted } : {}), ...(publish ? { publish: true } : {}) }); onSubmitted(); }
    catch (failure) { setError(failure); setBusy(false); }
    finally { pending.current = false; }
  };
  return <CommunityDialog title={entry.title[locale]} eyebrow={t('Install preview')} busy={busy} onClose={onClose} footer={<><Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t('Cancel')}</Button><Button isDisabled={busy || preview === undefined || preview.creates.length === 0} onPress={() => { void submit(); }}>{t('Install entry')}</Button></>}>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {preview === undefined ? <p role="status">{t('Loading…')}</p> : <>
      <p>{t('Catalog version {version}', { version: preview.version })}</p>
      <p>{t('This entry will install:')}</p>
      <ul>{preview.creates.map(item => <li key={item.kind + ':' + item.name}>{t(kindLabels[item.kind])} · {item.name}{item.commands?.length ? ` (${item.commands.join(', ')})` : ''}{item.detail ? ` · ${item.detail}` : ''}</li>)}</ul>
      {preview.conflicts?.length ? <CommunityMessage role="alert" status="warning" title={t('These skills already exist with a different origin: {names}', { names: preview.conflicts.join(', ') })}/>: null}
      <p>{t('Preparation uses your configured download sources and verifies every download.')}</p>
      {entry.category === 'suite' ? <div className="page-stack">
        <h2>{t('Access and publication (optional)')}</h2>
        {ordinaryGroups.length ? ordinaryGroups.map(group => <Checkbox key={group.id} isSelected={granted.includes(group.id)} onChange={selected => setGranted(current => selected ? [...current, group.id] : current.filter(id => id !== group.id))} isDisabled={busy}>
          <Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{t('Grant to {name}', { name: group.name })}</Checkbox.Content>
        </Checkbox>) : <p>{t('No ordinary groups yet.')}</p>}
        <Checkbox isSelected={publish} onChange={setPublish} isDisabled={busy}>
          <Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{t('Publish to the platform app center')}</Checkbox.Content>
        </Checkbox>
        <p>{t('Both choices are optional and can be changed later.')}</p>
      </div> : null}
      <p>{t('Installing an entry does not grant it to groups or publish it.')}</p>
    </>}
  </CommunityDialog>;
}

function UninstallDialog({ entry, onClose, onSubmitted }: { entry: CommunitySuiteCatalogEntryView; onClose: () => void; onSubmitted: () => void }) {
  const { t, locale, errorText } = usePlatformLanguage();
  const [preview, setPreview] = useState<CommunitySuiteUninstallPreview>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void communitySuiteUninstallPreview(entry.id, controller.signal).then(setPreview).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [entry.id]);
  const submit = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { await uninstallCommunitySuite(entry.id); onSubmitted(); }
    catch (failure) { setError(failure); setBusy(false); }
    finally { pending.current = false; }
  };
  const blocked = preview?.blocked.some(item => item.references.length > 0) ?? false;
  return <CommunityDialog title={entry.title[locale]} eyebrow={t('Uninstall preview')} busy={busy} onClose={onClose} footer={<><Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t('Cancel')}</Button><Button variant="danger" isDisabled={busy || preview === undefined || blocked} onPress={() => { void submit(); }}>{t('Confirm uninstall')}</Button></>}>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {preview === undefined ? <p role="status">{t('Loading…')}</p> : <>
      <p>{t('This will remove:')}</p>
      <ul>{preview.removes.length ? preview.removes.map(item => <li key={item.kind + ':' + item.name}>{t(kindLabels[item.kind])} · {item.name}</li>) : <li>—</li>}</ul>
      {preview.impact.length ? <><p>{t('Uninstall impact')}</p><ul>{preview.impact.map(item => <li key={item.name}>{item.name} · {item.groups.length ? t('Granted to: {groups}', { groups: item.groups.map(group => group.name).join(', ') }) : t('No group grants')} · {t(item.published ? 'Published' : 'Not published')} · {t('{count} members selected this pack.', { count: item.selectedMembers })}</li>)}</ul></> : null}
      {preview.blocked.length ? <CommunityMessage role="alert" status="warning" title={t('Remove these references before deleting the dependency.')}><ul>{preview.blocked.flatMap(item => item.references.map(reference => <li key={item.name + ':' + reference.kind + ':' + reference.name}>{reference.kind} · {reference.name} → {item.name}</li>))}</ul></CommunityMessage> : null}
      <p>{t('Uninstalling removes the entries and their prepared files.')}</p>
    </>}
  </CommunityDialog>;
}
