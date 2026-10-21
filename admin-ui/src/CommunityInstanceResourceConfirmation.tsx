import { Button } from '@heroui/react/button';
import type { CommunityInstanceResourceMember } from '../../src/domain/admin-contract';
import { memoryLimitReduced } from '../../src/domain/instance-resources';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';

export default function CommunityInstanceResourceConfirmation({ members, busy, error, onCancel, onConfirm }: { members: readonly CommunityInstanceResourceMember[], busy: boolean, error?: unknown, onCancel: () => void, onConfirm: () => void }) {
  const { t, errorText } = usePlatformLanguage();
  const reducingMemory = members.some(member => memoryLimitReduced(member.current?.memoryMiB ?? null, member.target.memoryMiB));
  return <CommunityDialog title={t('Apply resource limits?')} busy={busy} onClose={onCancel} footer={<><Button variant="tertiary" isDisabled={busy} onPress={onCancel}>{t('Cancel')}</Button><Button variant={reducingMemory ? 'danger' : 'primary'} isDisabled={busy} onPress={onConfirm}>{t('Apply now')}</Button></>}>
    <p>{t('This affects {count} running instances.', { count: members.length })}</p>
    <p>{t('If live application is unavailable, the instance will restart and its tasks will be interrupted.')}</p>
    {reducingMemory && <CommunityMessage status="warning" title={t('Reducing memory may terminate running tasks.')}/>}
    {error !== undefined && <CommunityMessage role="alert" status="danger" title={errorText(error)}/>}
  </CommunityDialog>;
}
