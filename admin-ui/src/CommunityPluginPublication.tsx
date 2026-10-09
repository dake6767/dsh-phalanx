import { useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityPluginView } from '../../src/domain/admin-contract';
import { communityPluginImpact, publishCommunityPlugin } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';
export default function CommunityPluginPublication({ plugin, onChanged }: { plugin: CommunityPluginView; onChanged: () => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [count, setCount] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const apply = async (published: boolean, selectedMembers?: number) => {
    setBusy(true); setError(undefined);
    try { await publishCommunityPlugin({ action: 'publish', packageName: plugin.packageName, published, ...(published ? {} : { confirmed: true, selectedMembers }) }); setCount(undefined); onChanged(); }
    catch (error) { setError(error); setCount(undefined); onChanged(); } finally { setBusy(false); }
  };
  const review = async () => {
    if (!plugin.published && !plugin.publicationPaused) { await apply(true); return; }
    setBusy(true); setError(undefined);
    try { setCount((await communityPluginImpact(plugin.packageName)).selectedMembers ?? 0); }
    catch (error) { setError(error); } finally { setBusy(false); }
  };
  return <>{error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <Button variant="secondary" isDisabled={busy || plugin.removing || (!plugin.published && !plugin.publicationPaused && plugin.stage !== 'available')} onPress={() => { void review(); }}>{t(plugin.publicationPaused ? 'Cancel automatic republication' : plugin.published ? 'Unpublish' : 'Publish to marketplace')}</Button>
    <p>{t('Unpublishing removes member selections. Running instances change after restart.')}</p>
    {count !== undefined ? <CommunityDialog title={t('Confirm unpublishing')} busy={busy} onClose={() => setCount(undefined)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => setCount(undefined)}>{t('Cancel')}</Button><Button variant="danger" isDisabled={busy} onPress={() => { void apply(false, count); }}>{t('Confirm')}</Button></>}>
      <p>{t('This affects {count} members who selected this plugin.', { count })}</p><p>{t('Group grants remain. Other selections stop loading after members restart.')}</p>
    </CommunityDialog> : null}</>;
}
