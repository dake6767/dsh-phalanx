import { usePlatformLanguage } from './CommunityLanguage';
import { useId, useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityAccountView } from '../../src/domain/admin-contract';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';
import { Checkbox } from '@heroui/react/checkbox';
export default function CommunityEnvironmentResetDialog({ account, busy, error, onCancel, onConfirm }: {
  account: CommunityAccountView; busy: boolean; error?: unknown; onCancel: () => void; onConfirm: () => Promise<void>;
}) {
  const { t, errorText } = usePlatformLanguage();
  const [confirmed, setConfirmed] = useState(false);
  const formId = useId();
  return <CommunityDialog title={t("Reset DSH environment: {username}", { username: account.username })} busy={busy} onClose={onCancel}
    footer={<><Button type="button" variant="tertiary" isDisabled={busy} onPress={onCancel}>{t("Cancel")}</Button><Button variant="danger" type="submit" form={formId} isDisabled={busy || !confirmed}>{busy ? t("Resetting\u2026") : t("Reset environment")}</Button></>}>
    <p>{t("The instance will stop. Its DSH configuration and user plugins will be backed up privately, then reset to platform defaults. Projects, chats and other personal files stay in the same user space. An instance will be created if needed.")}</p>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <form id={formId} onSubmit={event => { event.preventDefault(); if (confirmed && !busy) void onConfirm(); }}>
      <Checkbox className="confirm-checkbox" isSelected={confirmed} onChange={setConfirmed} isRequired isDisabled={busy}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{t("I understand that running tasks will be interrupted.")}</Checkbox.Content></Checkbox>
    </form>
  </CommunityDialog>;
}
