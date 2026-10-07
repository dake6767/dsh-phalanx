import { useId, useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityAccountView } from '../../src/domain/admin-contract';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';
import { Checkbox } from '@heroui/react/checkbox';
export default function CommunityEnvironmentResetDialog({ account, busy, error, onCancel, onConfirm }: {
  account: CommunityAccountView; busy: boolean; error?: string; onCancel: () => void; onConfirm: () => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const formId = useId();
  return <CommunityDialog title={`Reset DSH environment: ${account.username}`} busy={busy} onClose={onCancel}
    footer={<><Button type="button" variant="tertiary" isDisabled={busy} onPress={onCancel}>Cancel</Button><Button variant="danger" type="submit" form={formId} isDisabled={busy || !confirmed}>{busy ? 'Resetting…' : 'Reset environment'}</Button></>}>
    <p>The instance will stop. Its DSH configuration and user plugins will be backed up privately, then reset to platform defaults. Projects, chats and other personal files stay in the same user space. An instance will be created if needed.</p>
    {error ? <CommunityMessage role="alert" status="danger" title={error}/> : null}
    <form id={formId} onSubmit={event => { event.preventDefault(); if (confirmed && !busy) void onConfirm(); }}>
      <Checkbox className="confirm-checkbox" isSelected={confirmed} onChange={setConfirmed} isRequired isDisabled={busy}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>I understand that running tasks will be interrupted.</Checkbox.Content></Checkbox>
    </form>
  </CommunityDialog>;
}
