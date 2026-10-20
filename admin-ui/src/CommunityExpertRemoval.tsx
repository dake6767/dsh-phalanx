import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityExpertImpact } from '../../src/domain/admin-contract';
import { communityExpertImpact, removeCommunityExpert } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';

export default function CommunityExpertRemoval({ id, onClose, onRemoved }: { id: string; onClose: () => void; onRemoved: () => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [impact, setImpact] = useState<CommunityExpertImpact>(), [error, setError] = useState<unknown>(), [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void communityExpertImpact(id, controller.signal).then(value => { if (!controller.signal.aborted) setImpact(value); }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [id]);
  const remove = async () => {
    if (!impact || pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { await removeCommunityExpert(id, impact.revision); onRemoved(); }
    catch (failure) { setError(failure); } finally { pending.current = false; setBusy(false); }
  };
  return <CommunityDialog title={t('Delete expert')} busy={busy} onClose={onClose} footer={<><Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t('Cancel')}</Button><Button variant="danger" isDisabled={!impact || busy} onPress={() => { void remove(); }}>{t('Delete expert')}</Button></>}>
    {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <p>{t('Deleting this expert immediately withdraws its exclusive access. Its sessions cannot continue after members restart; history is retained.')}</p>
    {!impact ? <p role="status">{t('Loading…')}</p> : <><h3>{impact.expert.name}</h3><section aria-label={t('Members holding this expert')}><h4>{t('Members holding this expert')}</h4><ul>{impact.members.map(name => <li key={name}>{name}</li>)}</ul></section><section aria-label={t('Groups holding this expert')}><h4>{t('Groups holding this expert')}</h4><ul>{impact.groups.map(group => <li key={group.id}>{group.name}</li>)}</ul></section></>}
  </CommunityDialog>;
}
