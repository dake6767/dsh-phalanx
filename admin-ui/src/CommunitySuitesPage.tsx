import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { Checkbox } from '@heroui/react/checkbox';
import { Chip } from '@heroui/react/chip';
import CommunityIcon from './CommunityIcon';
import type { CommunityGroupView, CommunitySuiteCatalogEntryView, CommunitySuiteCatalogView, CommunitySuiteInstallPreview, CommunitySuiteInstallView, CommunitySuiteUninstallPreview } from '../../src/domain/admin-contract';
import { communityGroups, communitySuiteInstallPreview, communitySuites, communitySuiteUninstallPreview, detachCommunitySuiteEntry, installCommunitySuite, saveCommunitySuiteCredentials, uninstallCommunitySuite } from './community-api';
import CommunityField from './CommunityField';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';
import CommunitySelect from './CommunitySelect';
import { communityRequestId } from './community-request-id';
import type { PlatformMessageKey } from '../../src/domain/platform-copy';

const kindLabels = { 'runtime-dependency': 'Runtime dependencies', 'skill': 'Skills', 'skill-pack': 'Skill pack', 'execution': 'Delegated execution' } as const satisfies Record<string, PlatformMessageKey>;

export default function CommunitySuitesPage() {
  const { t, locale, errorText } = usePlatformLanguage();
  const [view, setView] = useState<CommunitySuiteCatalogView>();
  const [filter, setFilter] = useState('all');
  const [installing, setInstalling] = useState<CommunitySuiteCatalogEntryView>();
  const [uninstalling, setUninstalling] = useState<CommunitySuiteCatalogEntryView>();
  const [details, setDetails] = useState<CommunitySuiteCatalogEntryView>();
  const [detaching, setDetaching] = useState<{ id: string, entry: CommunitySuiteInstallView['entries'][number] }>();
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
        // Runtime dependency details link here to switch a manual dependency to the catalog version.
        const requested = new URLSearchParams(window.location.search).get('install');
        const target = requested ? next.entries.find(row => row.id === requested && !next.installations.some(item => item.id === row.id)) : undefined;
        if (target) { setInstalling(target); window.history.replaceState(null, '', window.location.pathname); }
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
    if (installation.status === 'installed' && entry.updateAvailable) return { label: t('Update available'), tone: 'success', busy: false };
    if (installation.status === 'installed' && installation.missingCredentials?.length) return { label: t('Missing credentials'), tone: 'warning', busy: false };
    if (installation.status === 'installed') return { label: t('Installed'), tone: 'success', busy: false };
    if (installation.status === 'failed') return { label: t('Installation failed. You can retry.'), tone: 'danger', busy: false };
    return { label: t(installation.status === 'installing' ? 'Installing' : installation.status === 'detaching' ? 'Detaching' : 'Uninstalling'), tone: 'warning', busy: true };
  };
  const titleOf = (id: string): string => entries.find(row => row.id === id)?.title[locale] ?? id;
  // A catalog dependency that suites satisfy with a same-command manual dependency instead of its own copy.
  const manualOf = (entry: CommunitySuiteCatalogEntryView): string | undefined => view?.installations.flatMap(row => row.manualDependencies ?? []).find(row => row.id === entry.id)?.name;
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
              {entry.dependencies?.length ? <div><dt>{t('Shared dependencies')}</dt><dd>{entry.dependencies.map(id => titleOf(id)).join(', ')}</dd></div> : null}
            </dl>
            {!entry.available ? <p className="plugin-card-error">{t('Unavailable on this architecture')}</p> : null}
            {manualOf(entry) !== undefined && installationOf(entry) === undefined ? <p>{t('Your manual dependency {name} is used; its version is not pinned', { name: manualOf(entry)! })}</p> : null}
            <div className="plugin-card-status" role="status"><span className={stageClass(statusOf(entry).tone)}><span aria-hidden="true"/>{statusOf(entry).label}</span></div>
          </Card.Content>
          <Card.Footer>
            <span className="plugin-details-label" aria-hidden="true">{t('Suite entry details')}<CommunityIcon name="chevron" size={14}/></span>
            <Button variant="tertiary" size="sm" aria-label={t('View suite entry {name}', { name: entry.title[locale] })} className="plugin-details-action" onPress={() => setDetails(entry)}/>
            {installationOf(entry) === undefined ? <Button className="relative z-10" size="sm" variant="secondary" isDisabled={!entry.available} onPress={() => setInstalling(entry)}>{t(manualOf(entry) !== undefined ? 'Switch to the catalog version' : 'Install')}</Button>
              : installationOf(entry)?.status === 'failed' ? <Button className="relative z-10" size="sm" variant="secondary" onPress={() => setInstalling(entry)}>{t('Retry install')}</Button>
              : installationOf(entry)?.status === 'installed' ? <Button className="relative z-10" size="sm" variant="secondary" isDisabled={statusOf(entry).busy} onPress={() => setUninstalling(entry)}>{t('Uninstall')}</Button> : null}
          </Card.Footer>
        </Card>)}</div>}
      <div className="panel-footer plugin-library-note"><CommunityIcon name="shield" size={16}/><span>{t('Installing an entry does not grant it to groups or publish it.')}</span></div>
    </section>
    {installing ? <InstallDialog entry={installing} titleOf={titleOf} onClose={() => setInstalling(undefined)} onSubmitted={() => { setInstalling(undefined); refresh(); }}/> : null}
    {detaching ? <DetachDialog suite={detaching.id} entry={detaching.entry} onClose={() => setDetaching(undefined)} onSubmitted={() => { setDetaching(undefined); refresh(); }}/> : null}
    {uninstalling ? <UninstallDialog entry={uninstalling} titleOf={titleOf} onClose={() => setUninstalling(undefined)} onSubmitted={() => { setUninstalling(undefined); refresh(); }}/> : null}
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
            {details.execution ? <div><dt>{t('Delegated execution')}</dt><dd>{details.execution.commands.map(row => row.command + (row.blocked.length ? ` (${t('Blocked first arguments: {names}', { names: row.blocked.join(' ') })})` : '')).join(', ')}</dd></div> : null}
          </dl>
          {installationOf(details)?.manualDependencies?.length ? <><h2>{t('Shared dependencies')}</h2><ul>{installationOf(details)!.manualDependencies!.map(row => <li key={row.id}>{titleOf(row.id)} · {t('Your manual dependency {name} is used; its version is not pinned', { name: row.name })}</li>)}</ul></> : null}
          {installationOf(details)?.replaced?.length ? <><h2>{t('Replaced manual entries')}</h2><ul>{installationOf(details)!.replaced!.map(row => <li key={row.kind + ':' + row.name}>{t(kindLabels[row.kind])} · {row.name}</li>)}</ul></> : null}
          {details.execution && installationOf(details)?.status === 'installed' ? <SuiteCredentials entry={details} missing={installationOf(details)!.missingCredentials ?? []} onSaved={refresh}/> : null}
          <p>{t('Suite catalog entries install as read-only runtime dependencies.')}</p>
          {installationOf(details)?.entries.length ? <><h2>{t('Installed entries')}</h2><ul>{installationOf(details)!.entries.map(entry => <li key={entry.kind + ':' + entry.name}>{t(kindLabels[entry.kind])} · {entry.name}
            {installationOf(details)!.status === 'installed' ? <> <Button size="sm" variant="tertiary" aria-label={t('Detach {name} from the suite', { name: entry.name })} onPress={() => setDetaching({ id: details.id, entry })}>{t('Detach from suite')}</Button></> : null}</li>)}</ul></> : null}
          {installationOf(details) ? <><h2>{t('Task log')}</h2><pre className="plugin-preparation-log">{installationOf(details)!.log}</pre></> : null}
        </section>
      </div>
    </CommunityDialog> : null}
  </div>;
}

function InstallDialog({ entry, titleOf, onClose, onSubmitted }: { entry: CommunitySuiteCatalogEntryView; titleOf: (id: string) => string; onClose: () => void; onSubmitted: () => void }) {
  const { t, locale, errorText } = usePlatformLanguage();
  const [preview, setPreview] = useState<CommunitySuiteInstallPreview>();
  const [groups, setGroups] = useState<readonly CommunityGroupView[]>();
  const [granted, setGranted] = useState<readonly string[]>([]);
  const [publish, setPublish] = useState(false);
  const [credentials, setCredentials] = useState<Readonly<Record<string, string>>>({});
  const [replace, setReplace] = useState(false);
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
    const filled = filledCredentials(credentials);
    try { await installCommunitySuite({ id: entry.id, requestId, ...(granted.length ? { groups: granted } : {}), ...(publish ? { publish: true } : {}), ...(Object.keys(filled).length ? { credentials: filled } : {}), ...(replace && preview?.replacements?.length ? { replace: preview.replacements } : {}) }); onSubmitted(); }
    catch (failure) { setError(failure); setBusy(false); }
    finally { pending.current = false; }
  };
  return <CommunityDialog title={entry.title[locale]} eyebrow={t('Install preview')} busy={busy} onClose={onClose} footer={<><Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t('Cancel')}</Button><Button isDisabled={busy || preview === undefined || preview.creates.length === 0 || Boolean(preview.replacements?.length) && !replace} onPress={() => { void submit(); }}>{t('Install entry')}</Button></>}>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {preview === undefined ? <p role="status">{t('Loading…')}</p> : <>
      <p>{t('Catalog version {version}', { version: preview.version })}</p>
      <p>{t('This entry will install:')}</p>
      <ul>{preview.creates.map(item => <li key={item.kind + ':' + item.name}>{t(kindLabels[item.kind])} · {item.name}{item.commands?.length ? ` (${item.commands.join(', ')})` : ''}{item.detail ? ` · ${item.detail}` : ''}</li>)}</ul>
      {preview.dependencies?.length ? <><p>{t('Shared runtime dependencies:')}</p><ul>{preview.dependencies.map(row => <li key={row.id}>{titleOf(row.id)} · {row.action === 'manual' ? t('Your manual dependency {name} is used; its version is not pinned', { name: row.name ?? row.id }) : t(row.action === 'install' ? 'Installed together with this suite' : 'Already in the library; reused without preparing again')}</li>)}</ul></> : null}
      {preview.replacements?.length && preview.creates.length ? <div className="page-stack">
        <CommunityMessage role="alert" status="warning" title={t('These manual entries will be replaced by the catalog version:')}/>
        <ul>{preview.replacements.map(row => <li key={row.kind + ':' + row.name}>{t(kindLabels[row.kind])} · {row.name}</li>)}</ul>
        <p>{t('The catalog takes these entries over under the same names, so their references, group grants, publication and member selections carry over. If the install fails, they stay as they were.')}</p>
        <Checkbox isSelected={replace} onChange={setReplace} isDisabled={busy}>
          <Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{t('Replace these manual entries')}</Checkbox.Content>
        </Checkbox>
      </div> : null}
      {preview.dependencyConflicts?.length ? <CommunityMessage role="alert" status="warning" title={t('These dependencies already provide the same commands: {names}', { names: preview.dependencyConflicts.join(', ') })}/> : null}
      {preview.packConflicts?.length ? <CommunityMessage role="alert" status="warning" title={t('These skill pack names are already used by a manual pack; rename or remove it first: {names}', { names: preview.packConflicts.join(', ') })}/> : null}
      {preview.commandConflicts?.length ? <CommunityMessage role="alert" status="warning" title={t('These commands are already delegated by another skill: {names}', { names: preview.commandConflicts.join(', ') })}/> : null}
      {preview.conflicts?.length ? <CommunityMessage role="alert" status="warning" title={t('These skills already exist with a different origin: {names}', { names: preview.conflicts.join(', ') })}/>: null}
      <p>{t('Preparation uses your configured download sources and verifies every download.')}</p>
      {entry.identity ? <p>{entry.identity[locale]}</p> : null}
      {entry.execution && preview.creates.length ? <div className="page-stack">
        <h2>{t('Team credentials (optional)')}</h2>
        {entry.execution.variables.map(variable => <CommunityField key={variable.name} label={variable.name} type="password" autoComplete="new-password" value={credentials[variable.name] ?? ''} onChange={value => setCredentials(current => ({ ...current, [variable.name]: value }))} disabled={busy} description={variable.purpose[locale]}/>)}
        <p>{t('You can skip this step. Delegated execution stays off until every credential is saved.')}</p>
      </div> : null}
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

function UninstallDialog({ entry, titleOf, onClose, onSubmitted }: { entry: CommunitySuiteCatalogEntryView; titleOf: (id: string) => string; onClose: () => void; onSubmitted: () => void }) {
  const { t, locale, errorText } = usePlatformLanguage();
  const [preview, setPreview] = useState<CommunitySuiteUninstallPreview>();
  const [removeDependencies, setRemoveDependencies] = useState<readonly string[]>([]);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    // Unreferenced shared dependencies are offered for removal and checked by default.
    void communitySuiteUninstallPreview(entry.id, controller.signal).then(value => { setPreview(value); setRemoveDependencies(value.dependencies.filter(row => !row.references.length).map(row => row.id)); }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [entry.id]);
  const submit = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { await uninstallCommunitySuite(entry.id, { removeDependencies }); onSubmitted(); }
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
      {preview.dependencies.length ? <div className="page-stack"><p>{t('Shared runtime dependencies:')}</p>{preview.dependencies.map(row => row.references.length
        ? <p key={row.id}>{t('{name} stays installed because it is still used by: {references}', { name: titleOf(row.id), references: row.references.map(reference => `${reference.kind} · ${reference.name}`).join(', ') })}</p>
        : <Checkbox key={row.id} isSelected={removeDependencies.includes(row.id)} onChange={selected => setRemoveDependencies(current => selected ? [...current, row.id] : current.filter(id => id !== row.id))} isDisabled={busy}>
          <Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{t('Also remove {name}; nothing else uses it', { name: titleOf(row.id) })}</Checkbox.Content>
        </Checkbox>)}</div> : null}
      <p>{t('Uninstalling removes the entries and their prepared files.')}</p>
    </>}
  </CommunityDialog>;
}

/** Blank fields mean "skip" in the wizard and "keep the saved value" in the details. */
function filledCredentials(values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== ''));
}

function SuiteCredentials({ entry, missing, onSaved }: { entry: CommunitySuiteCatalogEntryView; missing: readonly string[]; onSaved: () => void }) {
  const { t, locale, errorText } = usePlatformLanguage();
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const filled = filledCredentials(values);
  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(undefined); setSaved(false);
    try { await saveCommunitySuiteCredentials(entry.id, filled); setValues({}); setSaved(true); onSaved(); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  return <section className="page-stack" aria-label={t('Team credentials')}>
    <h2>{t('Team credentials')}</h2>
    {missing.length ? <CommunityMessage role="status" status="warning" title={t('Missing credentials')}><p>{t('Delegated execution is off until these credentials are saved: {names}', { names: missing.join(', ') })}</p></CommunityMessage>
      : <CommunityMessage role="status" status="success" title={t('Credentials are saved. Delegated execution is on.')}/>}
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {entry.execution!.variables.map(variable => <CommunityField key={variable.name} label={variable.name} type="password" autoComplete="new-password" value={values[variable.name] ?? ''} onChange={value => setValues(current => ({ ...current, [variable.name]: value }))} disabled={busy}
      description={(missing.includes(variable.name) ? '' : t('A credential is saved. Leave blank to keep it.') + ' ') + variable.purpose[locale]}/>)}
    {saved ? <CommunityMessage role="status" status="success" title={t('Credentials saved.')}/> : null}
    <div><Button variant="secondary" isDisabled={busy || Object.keys(filled).length === 0} onPress={() => { void submit(); }}>{t('Save credentials')}</Button></div>
  </section>;
}

function DetachDialog({ suite, entry, onClose, onSubmitted }: { suite: string; entry: CommunitySuiteInstallView['entries'][number]; onClose: () => void; onSubmitted: () => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await detachCommunitySuiteEntry(suite, entry); onSubmitted(); }
    catch (failure) { setError(failure); setBusy(false); }
  };
  return <CommunityDialog title={t('Detach {name} from the suite?', { name: entry.name })} eyebrow={t(kindLabels[entry.kind])} busy={busy} onClose={onClose} footer={<><Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t('Cancel')}</Button><Button isDisabled={busy} onPress={() => { void submit(); }}>{t('Detach from suite')}</Button></>}>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <p>{t('The entry becomes an ordinary library entry you can edit. It no longer follows suite updates and stays when the suite is uninstalled.')}</p>
    <p>{t('Its grants, publication and references do not change.')}</p>
  </CommunityDialog>;
}
