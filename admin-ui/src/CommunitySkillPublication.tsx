import { useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunitySkillDetail } from '../../src/domain/admin-contract';
import { changeCommunitySkill } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';

export default function CommunitySkillPublication({ detail }: { detail: CommunitySkillDetail }) {
  const { t, errorText } = usePlatformLanguage();
  const [confirmation, setConfirmation] = useState<CommunitySkillDetail>(), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const title = confirmation?.published ? 'Confirm skill unpublication' : 'Confirm skill publication';
  const apply = async () => {
    if (!confirmation || busy) return;
    setBusy(true); setError(undefined);
    try { await changeCommunitySkill({ action: 'publish', name: confirmation.name, published: !confirmation.published, revision: confirmation.revision }); setConfirmation(undefined); }
    catch (failure) { setError(failure); setConfirmation(undefined); }
    finally { setBusy(false); }
  };
  return <section className="plugin-detail-section"><h2>{t('Publication')}</h2><p>{t('Publishing makes this skill available for all members to select.')}</p><p>{t('Unpublishing removes member selections. Managed grants are kept.')}</p>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <Button variant="secondary" isDisabled={busy || (!detail.published && !!detail.conflict)} onPress={() => setConfirmation(detail)}>{t(detail.published ? 'Unpublish' : 'Publish to marketplace')}</Button>
    {confirmation ? <CommunityDialog title={t(title)} busy={busy} onClose={() => setConfirmation(undefined)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => setConfirmation(undefined)}>{t('Cancel')}</Button><Button isDisabled={busy} onPress={() => { void apply(); }}>{t('Confirm')}</Button></>}><p>{confirmation.name}</p><p>{t('{count} members selected this skill.', { count: confirmation.selectedMembers })}</p><CommunityMessage status="warning" title={t('Changes apply to new sessions. Running tasks using this skill may fail.')}/></CommunityDialog> : null}
  </section>;
}
