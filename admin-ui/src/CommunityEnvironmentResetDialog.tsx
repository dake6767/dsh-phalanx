import { useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityAccountView } from '../../src/domain/admin-contract';
import CommunityDialog from './CommunityDialog';
export default function CommunityEnvironmentResetDialog({ account, busy, error, onCancel, onConfirm }: {
  account: CommunityAccountView; busy: boolean; error?: string; onCancel: () => void; onConfirm: () => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  return <CommunityDialog title={`Reset DSH environment: ${account.username}`} busy={busy} onClose={onCancel}>
    <p>The instance will stop. Its DSH configuration and user plugins will be backed up privately, then reset to platform defaults. Projects, chats and other personal files stay in the same user space. An instance will be created if needed.</p>
    {error ? <p role="alert" className="message error">{error}</p> : null}
    <form onSubmit={event => { event.preventDefault(); if (confirmed && !busy) void onConfirm(); }}>
      <label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required disabled={busy}/>I understand that running tasks will be interrupted.</label>
      <div className="dialog-actions"><Button type="button" variant="tertiary" isDisabled={busy} onPress={onCancel}>Cancel</Button><Button variant="danger" type="submit" isDisabled={busy || !confirmed}>{busy ? 'Resetting…' : 'Reset environment'}</Button></div>
    </form>
  </CommunityDialog>;
}
