import CommunityPluginChanges from './CommunityPluginChanges';
import CommunityPluginUploadDialog from './CommunityPluginUploadDialog';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import type { CommunityPluginStage, CommunityPluginView } from '../../src/domain/admin-contract';
import { platformError } from '../../src/domain/platform-copy';
import { addCommunityPlugin, communityPlugins, publishCommunityPlugin } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';
import { useDraftGuard } from './useDraftGuard';

const stageLabels = { resolving: 'Resolving package', downloading: 'Downloading package', installing: 'Installing dependencies', prechecking: 'Checking offline compatibility', available: 'Available', failed: 'Precheck failed' } as const satisfies Record<CommunityPluginStage, string>;

export default function CommunityPluginsPage() {
  const { t, locale, errorText } = usePlatformLanguage();
  const [plugins, setPlugins] = useState<readonly CommunityPluginView[]>();
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
  const publish = async (plugin: CommunityPluginView) => {
    if (pending.current) return;
    pending.current = true; setRetrying(plugin.packageName);
    try { await publishCommunityPlugin({ action: 'publish', packageName: plugin.packageName, published: !plugin.published && !plugin.publicationPaused }); refresh(); }
    catch (failure) { setError(failure); }
    finally { pending.current = false; setRetrying(undefined); }
  };
  const detail = plugins?.find(plugin => plugin.packageName === selected);
  const stageText = (plugin: CommunityPluginView) => t(plugin.incompatible ? 'Incompatible with the current version' : plugin.source === 'upload' && plugin.stage === 'downloading' ? 'Preparing uploaded archive' : stageLabels[plugin.stage]);
  const failureText = (plugin: CommunityPluginView) => platformError(locale, { code: plugin.failureCode, error: '' });
  return <div className="page-stack">
    <div className="page-title"><div><h1>{t('Plugin library')}</h1><p>{t('Prepare plugins before making them available to members.')}</p></div><div className="flex flex-wrap gap-2"><Button onPress={() => setAdding(true)}>{t('Add npm plugin')}</Button><Button variant="secondary" onPress={() => setUploading(true)}>{t('Upload plugin archive')}</Button></div></div>
    <p>{t('Adding a plugin does not grant it to ordinary groups or publish it to the marketplace.')}</p>
    {error !== undefined ? <><CommunityMessage role="alert" status="danger" title={errorText(error)}/><Button variant="secondary" onPress={refresh}>{t('Reload plugins')}</Button></> : null}
    {plugins === undefined ? <p role="status">{t('Loading…')}</p> : plugins.length === 0 ? <Card><Card.Header><Card.Title>{t('No plugins yet')}</Card.Title><Card.Description>{t('Add a package name and exact version to start the precheck.')}</Card.Description></Card.Header></Card> :
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{plugins.map(plugin => <Card key={plugin.packageName} className="min-w-0 relative">
        <Card.Header><Card.Title className="break-words">{plugin.title}</Card.Title><Card.Description className="break-words">{plugin.description || plugin.packageName}</Card.Description></Card.Header>
        <Card.Content><p>{t(plugin.published ? 'Published' : 'Not published')}</p><p>{t(plugin.source === 'upload' ? 'Uploaded archive' : 'npm registry')}</p><p>{t('Version')}: {plugin.version}</p><p role="status">{stageText(plugin)}</p>{plugin.failures?.length ? <p>{t('Load failed for {count} members.', { count: plugin.failures.length })}</p> : null}{plugin.failureCode ? <p className="break-words">{failureText(plugin)}</p> : null}</Card.Content>
        <Card.Footer><Button variant="tertiary" onPress={() => setSelected(plugin.packageName)} aria-label={t('View plugin {name}', { name: plugin.packageName })} className="after:absolute after:inset-0">{t('Plugin details')}</Button>
          {plugin.stage === 'failed' ? <Button className="relative z-10" variant="secondary" isDisabled={retrying !== undefined} onPress={() => { void retry(plugin); }}>{t('Retry precheck')}</Button> : null}</Card.Footer>
      </Card>)}</div>}
    {uploading ? <CommunityPluginUploadDialog onClose={() => setUploading(false)} onAdded={() => { setUploading(false); refresh(); }}/> : null}
    {adding ? <AddPluginDialog onClose={() => setAdding(false)} onAdded={() => { setAdding(false); refresh(); }}/> : null}
    {detail ? <CommunityDialog drawer title={detail.title} closeLabel={t('Close plugin details')} onClose={() => setSelected(undefined)}>
      <div className="page-stack"><p className="break-words">{detail.packageName}</p><p>{detail.description}</p><p>{t(detail.source === 'upload' ? 'Uploaded archive' : 'npm registry')}</p><p>{t('Version')}: {detail.version}</p><p role="status">{stageText(detail)}</p>
        <p>{t(detail.published ? 'Published' : 'Not published')}</p>
        {detail.publicationPaused ? <p>{t('Publication paused until a compatible version is selected.')}</p> : null}
        <Button variant="secondary" isDisabled={retrying !== undefined || detail.removing || (!detail.published && !detail.publicationPaused && detail.stage !== 'available')} onPress={() => { void publish(detail); }}>{t(detail.publicationPaused ? 'Cancel automatic republication' : detail.published ? 'Unpublish' : 'Publish to marketplace')}</Button>
        <p>{t('Unpublishing keeps copies already installed by members.')}</p>
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
