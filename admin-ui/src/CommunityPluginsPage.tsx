import CommunityPluginPublication from './CommunityPluginPublication';
import CommunityPluginUpstreams from './CommunityPluginUpstreams';
import CommunityPluginChanges from './CommunityPluginChanges';
import CommunityPluginUploadDialog from './CommunityPluginUploadDialog';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { Chip } from '@heroui/react/chip';
import CommunityIcon from './CommunityIcon';
import type { CommunityPluginStage, CommunityPluginView } from '../../src/domain/admin-contract';
import { platformError } from '../../src/domain/platform-copy';
import { addCommunityPlugin, communityPlugins } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';
import CommunitySelect from './CommunitySelect';
import { useDraftGuard } from './useDraftGuard';

const stageLabels = { resolving: 'Resolving package', downloading: 'Downloading package', installing: 'Installing dependencies', prechecking: 'Checking offline compatibility', available: 'Available', failed: 'Precheck failed' } as const satisfies Record<CommunityPluginStage, string>;

export default function CommunityPluginsPage() {
  const { t, locale, errorText } = usePlatformLanguage();
  const [plugins, setPlugins] = useState<readonly CommunityPluginView[]>();
  const [publicationFilter, setPublicationFilter] = useState('all');
  const visiblePlugins = plugins?.filter(plugin => publicationFilter === 'all' || (publicationFilter === 'published' ? plugin.published : !plugin.published)) ?? [];
  const [uploading, setUploading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<unknown>();
  const [retrying, setRetrying] = useState<string>();
  const pending = useRef(false);
  const refresh = () => setRevision(value => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const items = await communityPlugins(controller.signal);
        if (controller.signal.aborted) return;
        setPlugins(items); setError(undefined);
        if (items.some(item => (item.stage !== 'available' && item.stage !== 'failed') || (item.replacement && item.replacement.stage !== 'available' && item.replacement.stage !== 'failed'))) timer = setTimeout(() => { void load(); }, 1000);
      } catch (failure) { if (!controller.signal.aborted) setError(failure); }
    };
    void load();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [revision]);
  const retry = async (plugin: CommunityPluginView) => {
    if (pending.current) return;
    pending.current = true; setRetrying(plugin.packageName);
    try { await addCommunityPlugin({ action: 'retry', packageName: plugin.packageName, version: plugin.version }); refresh(); }
    catch (failure) { setError(failure); }
    finally { pending.current = false; setRetrying(undefined); }
  };
  const detail = plugins?.find(plugin => plugin.packageName === selected);
  const stageText = (plugin: CommunityPluginView) => t(plugin.incompatible ? 'Incompatible with the current version' : plugin.source === 'upload' && plugin.stage === 'downloading' ? 'Preparing uploaded archive' : stageLabels[plugin.stage]);
  const failureText = (plugin: CommunityPluginView) => platformError(locale, { code: plugin.failureCode, error: '' });
  return <div className="community-page">
    <section className="page-heading plugin-page-heading"><div><h1>{t('Plugin library')}<span className="heading-dot" aria-hidden="true">.</span></h1><p>{t('Prepare plugins before making them available to members.')}</p></div><div className="plugin-page-actions"><Button className="primary-action" onPress={() => setAdding(true)}><CommunityIcon name="plus" size={16}/>{t('Add npm plugin')}</Button><Button variant="secondary" onPress={() => setUploading(true)}>{t('Upload plugin archive')}</Button></div></section>
    {error !== undefined ? <><CommunityMessage role="alert" status="danger" title={errorText(error)}/><Button variant="secondary" onPress={refresh}>{t('Reload plugins')}</Button></> : null}
    <section className="panel plugin-library-panel" aria-label={t('All plugins')}>
      <div className="panel-top panel-filter-header"><div><div className="panel-title-row"><h2>{t('All plugins')}</h2><span className="panel-item-count">{t('{count} plugins', { count: plugins ? visiblePlugins.length : '—' })}</span></div><p>{t('Review plugin versions, readiness and publication.')}</p></div>
        <CommunitySelect className="panel-filter" hideLabel label={t('Filter by publication')} value={publicationFilter} onChange={setPublicationFilter} options={[{ id: 'all', label: t('All plugins') }, { id: 'published', label: t('Published to marketplace') }, { id: 'unpublished', label: t('Not published') }]}/>
      </div>
      {plugins === undefined ? <p className="table-empty" role="status">{t('Loading…')}</p> : plugins.length === 0 ? <Card className="plugin-library-empty" variant="transparent"><Card.Header><span className="plugin-card-icon" aria-hidden="true"><CommunityIcon name="plugins" size={22}/></span><Card.Title>{t('No plugins yet')}</Card.Title><Card.Description>{t('Add a package name and exact version to start the precheck.')}</Card.Description></Card.Header></Card> : visiblePlugins.length === 0 ? <Card className="plugin-library-empty" variant="transparent"><Card.Header><Card.Title>{t('No plugins match this filter.')}</Card.Title><Card.Description>{t('Choose another publication status to view plugins.')}</Card.Description></Card.Header><Card.Footer><Button variant="secondary" onPress={() => setPublicationFilter('all')}>{t('Show all plugins')}</Button></Card.Footer></Card> :
        <div className="plugin-card-grid">{visiblePlugins.map(plugin => <Card key={plugin.packageName} className="plugin-library-card">
          <Card.Header>
            <div className="plugin-card-top"><span className="plugin-card-icon" aria-hidden="true"><CommunityIcon name="plugins" size={20}/></span><Chip size="sm" variant="soft" color={plugin.published ? 'success' : 'default'}>{t(plugin.published ? 'Published' : 'Not published')}</Chip></div>
            <Card.Title>{plugin.title}</Card.Title><span className="plugin-package-name">{plugin.packageName}</span>
            {plugin.description ? <Card.Description>{plugin.description}</Card.Description> : null}
          </Card.Header>
          <Card.Content>
            <dl className="plugin-card-metadata"><div><dt>{t('Source')}</dt><dd>{t(plugin.source === 'upload' ? 'Uploaded archive' : 'npm registry')}</dd></div><div><dt>{t('Version')}</dt><dd>{plugin.version}</dd></div></dl>
            <div className="plugin-card-status" role="status"><span className={plugin.incompatible || plugin.stage === 'failed' ? 'plugin-stage is-failed' : plugin.stage === 'available' ? 'plugin-stage is-available' : 'plugin-stage is-preparing'}><span aria-hidden="true"/>{stageText(plugin)}</span></div>
            {plugin.failures?.length ? <p className="plugin-card-error">{t('Load failed for {count} members.', { count: plugin.failures.length })}</p> : null}{plugin.failureCode ? <p className="plugin-card-error">{failureText(plugin)}</p> : null}
          </Card.Content>
          <Card.Footer><span className="plugin-details-label" aria-hidden="true">{t('Plugin details')}<CommunityIcon name="chevron" size={14}/></span><Button variant="tertiary" size="sm" onPress={() => setSelected(plugin.packageName)} aria-label={t('View plugin {name}', { name: plugin.packageName })} className="plugin-details-action"/>
            {plugin.stage === 'failed' ? <Button className="relative z-10" size="sm" variant="secondary" isDisabled={retrying !== undefined} onPress={() => { void retry(plugin); }}>{t('Retry precheck')}</Button> : null}</Card.Footer>
        </Card>)}</div>}
      <div className="panel-footer plugin-library-note"><CommunityIcon name="shield" size={16}/><span>{t('Adding a plugin does not grant it to ordinary groups or publish it to the marketplace.')}</span></div>
    </section>
    {uploading ? <CommunityPluginUploadDialog onClose={() => setUploading(false)} onAdded={() => { setUploading(false); refresh(); }}/> : null}
    {adding ? <AddPluginDialog onClose={() => setAdding(false)} onAdded={() => { setAdding(false); refresh(); }}/> : null}
    {detail ? <CommunityDialog drawer title={detail.title} closeLabel={t('Close plugin details')} onClose={() => setSelected(undefined)}>
      <div className="page-stack"><p className="break-words">{detail.packageName}</p><p>{detail.description}</p><p>{t(detail.source === 'upload' ? 'Uploaded archive' : 'npm registry')}</p><p>{t('Version')}: {detail.version}</p><p role="status">{stageText(detail)}</p>
        <p>{t(detail.published ? 'Published' : 'Not published')}</p>
        {detail.publicationPaused ? <p>{t('Publication paused until a compatible version is selected.')}</p> : null}
        <CommunityPluginPublication plugin={detail} onChanged={refresh}/>
        <CommunityPluginUpstreams key={detail.packageName} packageName={detail.packageName}/>
        <CommunityPluginChanges plugin={detail} onChanged={removed => { if (removed) setSelected(undefined); refresh(); }}/>
        {detail.integrity ? <div><p>{t('Integrity (sha512)')}</p><code className="break-all text-xs">{detail.integrity}</code></div> : null}
        {detail.failures?.map(failure => <CommunityMessage key={failure.username} status="danger" title={`${failure.username}: ${platformError(locale, { code: failure.code, error: '' })}`}/>)}
        {detail.failureCode ? <CommunityMessage role="alert" status="danger" title={failureText(detail)}/> : null}
        {detail.stage === 'failed' ? <Button variant="secondary" isDisabled={retrying !== undefined} onPress={() => { void retry(detail); }}>{t('Retry precheck')}</Button> : null}
      </div>
    </CommunityDialog> : null}
  </div>;
}

function AddPluginDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [packageName, setPackageName] = useState('');
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const pending = useRef(false);
  const id = useId();
  const save = async () => {
    if (pending.current || !packageName.trim() || !version.trim()) return false;
    pending.current = true; setBusy(true); setError(undefined);
    try { await addCommunityPlugin({ action: 'add', packageName: packageName.trim(), version: version.trim() }); onAdded(); return true; }
    catch (failure) { setError(failure); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  const guard = useDraftGuard(Boolean(packageName || version), save, () => { setPackageName(''); setVersion(''); }, busy);
  return <><CommunityDialog title={t('Add npm plugin')} busy={busy} onClose={() => guard.request(onClose)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(onClose)}>{t('Cancel')}</Button><Button type="submit" form={id} isDisabled={busy || !packageName.trim() || !version.trim()}>{t('Start precheck')}</Button></>}>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <form id={id} className="page-stack" onSubmit={event => { event.preventDefault(); void save(); }}>
      <CommunityField label={t('npm package name')} value={packageName} onChange={setPackageName} required autoFocus disabled={busy}/>
      <CommunityField label={t('Exact version')} value={version} onChange={setVersion} required disabled={busy}/>
      <p>{t('Use an exact version such as 1.2.3. Tags, ranges and Git sources are not supported.')}</p>
    </form>
  </CommunityDialog>{guard.dialog}</>;
}
