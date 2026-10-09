import { useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityPluginView } from '../../src/domain/admin-contract';
import { communityPluginImpact, publishCommunityPlugin } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';
export default function CommunityPluginPublication({ plugin, onChanged }: { plugin: CommunityPluginView; onChanged: () => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [publishing, setPublishing] = useState(false);
  const [count, setCount] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const apply = async (published: boolean, selectedMembers?: number, credentialConfirmed = false) => {
    setBusy(true); setError(undefined);
    try { await publishCommunityPlugin({ action: 'publish', packageName: plugin.packageName, published, ...(!published || credentialConfirmed ? { confirmed: true as const } : {}), ...(published ? {} : { selectedMembers }) }); setCount(undefined); setPublishing(false); onChanged(); }
    catch (error) { setError(error); setCount(undefined); setPublishing(false); onChanged(); } finally { setBusy(false); }
  };
  const review = async () => {
    if (!plugin.published && !plugin.publicationPaused) { if (plugin.hasPlatformCredential) setPublishing(true); else await apply(true); return; }
    setBusy(true); setError(undefined);
    try { setCount((await communityPluginImpact(plugin.packageName)).selectedMembers ?? 0); }
    catch (error) { setError(error); } finally { setBusy(false); }
  };
  return <>{error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <Button variant="secondary" isDisabled={busy || plugin.removing || (!plugin.published && !plugin.publicationPaused && plugin.stage !== 'available')} onPress={() => { void review(); }}>{t(plugin.publicationPaused ? 'Cancel automatic republication' : plugin.published ? 'Unpublish' : 'Publish to marketplace')}</Button>
    <p>{t('Unpublishing removes member selections. Running instances change after restart.')}</p>
    {publishing ? <CommunityDialog title={t('Confirm publication')} busy={busy} onClose={() => setPublishing(false)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => setPublishing(false)}>{t('Cancel')}</Button><Button isDisabled={busy} onPress={() => { void apply(true, undefined, true); }}>{t('Confirm')}</Button></>}>
      <p>{t('All members can select this platform app.')}</p>{plugin.hasPlatformCredential ? <p>{t('All members will use the platform credentials.')}</p> : null}
    </CommunityDialog> : null}
    {count !== undefined ? <CommunityDialog title={t('Confirm unpublishing')} busy={busy} onClose={() => setCount(undefined)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => setCount(undefined)}>{t('Cancel')}</Button><Button variant="danger" isDisabled={busy} onPress={() => { void apply(false, count); }}>{t('Confirm')}</Button></>}>
      <p>{t('This affects {count} members who selected this plugin.', { count })}</p><p>{t('Group grants remain. Other selections stop loading after members restart.')}</p>
    </CommunityDialog> : null}</>;
}
