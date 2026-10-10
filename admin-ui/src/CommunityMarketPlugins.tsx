import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import type { CommunityMarketPluginView } from '../../src/domain/admin-contract';
import { communityMarket, installMarketPlugin } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityMessage from './CommunityMessage';

export default function CommunityMarketPlugins() {
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
      try { const rows = await communityMarket(controller.signal); if (!controller.signal.aborted) { setPlugins(rows.plugins); setNotice(rows.pending ? 'restart-required' : undefined); setError(undefined); } }
      catch (failure) { if (!controller.signal.aborted) setError(failure); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => { void load(); }, 5000); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [revision]);
  const install = async (packageName: string, action: 'install' | 'uninstall') => {
    if (pending.current) return;
    pending.current = true; setBusy(packageName); setError(undefined); setNotice(undefined);
    try { const result = await installMarketPlugin({ packageName, action }); setNotice(result.application); setRevision(value => value + 1); }
    catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(undefined); }
  };
  return <section className="page-stack">
    <div className="page-title"><div><h2>{t('Plugins')}</h2><p>{t('Platform apps are loaded read-only after you restart your instance.')}</p></div><Button variant="tertiary" onPress={() => setRevision(value => value + 1)}>{t('Reload plugins')}</Button></div>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {notice ? <CommunityMessage role="status" status="success" title={t(notice === 'applied' ? 'Selection saved.' : 'Changes take effect after restarting your instance.')}/> : null}
    {notice === 'restart-required' ? <a href="/recovery?restart=1" target="_top">{t('Restart DSH instance')}</a> : null}
    {plugins === undefined ? <p role="status">{t('Loading…')}</p> : plugins.length === 0 ? <Card><Card.Header><Card.Title>{t('No published plugins')}</Card.Title></Card.Header></Card> :
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{plugins.map(plugin => <Card key={plugin.packageName}>
        <Card.Header><Card.Title className="break-words">{plugin.title}</Card.Title><Card.Description className="break-words">{plugin.description || plugin.packageName}</Card.Description></Card.Header>
        <Card.Content><p>{t('Version')}: {plugin.version}</p></Card.Content>
        <Card.Content><p>{t(plugin.status === 'managed' ? 'Installed (platform preinstalled)' : plugin.status === 'selected' ? 'Installed (platform app center)' : plugin.status === 'native' ? 'Installed on the native plugin page' : 'Not installed')}</p>{plugin.status === 'native' ? <p>{t('Uninstall on the native plugin page before selecting this platform app.')}</p> : null}</Card.Content>
        <Card.Footer><Button isDisabled={busy !== undefined || plugin.status === 'managed' || plugin.status === 'native'} onPress={() => { void install(plugin.packageName, plugin.status === 'selected' ? 'uninstall' : 'install'); }}>{t(busy === plugin.packageName ? 'Saving…' : plugin.status === 'selected' ? 'Uninstall' : plugin.status === 'managed' || plugin.status === 'native' ? 'Installed' : 'Install')}</Button></Card.Footer>
      </Card>)}</div>}
  </section>;
}
