import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import type { CommunityMarketPluginView } from '../../src/domain/admin-contract';
import { communityMarket, installMarketPlugin } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityMessage from './CommunityMessage';

export default function CommunityMarketPage() {
  const { t, errorText } = usePlatformLanguage();
  const [plugins, setPlugins] = useState<readonly CommunityMarketPluginView[]>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<'applied' | 'restart-required'>();
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const rows = await communityMarket(controller.signal); if (!controller.signal.aborted) { setPlugins(rows); setError(undefined); } }
      catch (failure) { if (!controller.signal.aborted) setError(failure); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => { void load(); }, 5000); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [revision]);
  const install = async (packageName: string) => {
    if (pending.current) return;
    pending.current = true; setBusy(packageName); setError(undefined); setNotice(undefined);
    try { const result = await installMarketPlugin({ packageName }); setNotice(result.application); setRevision(value => value + 1); }
    catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(undefined); }
  };
  return <main className="page-stack p-6">
    <div className="page-title"><div><h1>{t('Platform plugin marketplace')}</h1><p>{t('Plugins published by your administrator. Install a copy into your own space.')}</p></div><Button variant="tertiary" onPress={() => setRevision(value => value + 1)}>{t('Reload plugins')}</Button></div>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {notice ? <CommunityMessage role="status" status="success" title={t(notice === 'applied' ? 'Plugin installed.' : 'Plugin updated. Restart your instance to apply the new version.')}/> : null}
    {notice === 'restart-required' ? <a href="/recovery" target="_top">{t('Open instance controls')}</a> : null}
    {plugins === undefined ? <p role="status">{t('Loading…')}</p> : plugins.length === 0 ? <Card><Card.Header><Card.Title>{t('No published plugins')}</Card.Title></Card.Header></Card> :
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{plugins.map(plugin => <Card key={plugin.packageName}>
        <Card.Header><Card.Title className="break-words">{plugin.title}</Card.Title><Card.Description className="break-words">{plugin.description || plugin.packageName}</Card.Description></Card.Header>
        <Card.Content><p>{t('Version')}: {plugin.version}</p></Card.Content>
        <Card.Footer><Button isDisabled={busy !== undefined || plugin.status === 'installed'} onPress={() => { void install(plugin.packageName); }}>{t(busy === plugin.packageName ? 'Installing…' : plugin.status === 'installed' ? 'Installed' : plugin.status === 'update' ? 'Update available' : 'Install')}</Button></Card.Footer>
      </Card>)}</div>}
  </main>;
}
