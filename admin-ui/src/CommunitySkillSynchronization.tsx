import { useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import { communitySkillSynchronization, retrySkillSynchronization, skillSynchronizationEvent } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityMessage from './CommunityMessage';

export default function CommunitySkillSynchronization() {
  const { t, errorText } = usePlatformLanguage();
  const [pending, setPending] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  useEffect(() => {
    let controller: AbortController;
    const refresh = () => {
      controller?.abort(); controller = new AbortController(); const signal = controller.signal;
      void communitySkillSynchronization(signal).then(value => { if (!signal.aborted) { setPending(value.pending); setError(undefined); } }).catch(failure => { if (!signal.aborted) setError(failure); });
    };
    refresh(); window.addEventListener(skillSynchronizationEvent, refresh);
    return () => { controller.abort(); window.removeEventListener(skillSynchronizationEvent, refresh); };
  }, []);
  const retry = async () => {
    setBusy(true); setError(undefined);
    try { setPending((await retrySkillSynchronization()).pending); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  return <>{error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}{pending ? <div className="group-grants-status"><CommunityMessage role="alert" status="warning" title={t('Skill changes are not fully synchronized. Some members may still have the previous skills.')}/><Button variant="secondary" isDisabled={busy} onPress={() => { void retry(); }}>{t('Retry skill synchronization')}</Button></div> : null}</>;
}
