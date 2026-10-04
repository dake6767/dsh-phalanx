import { useEffect, useRef, useState } from 'react';
import type { CommunityAccountView } from '../../src/domain/admin-contract';

export default function CommunityEnvironmentResetDialog({ account, busy, error, onCancel, onConfirm }: {
  account: CommunityAccountView; busy: boolean; error?: string; onCancel: () => void; onConfirm: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="account-dialog" aria-labelledby="environment-reset-title"
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="environment-reset-title">Reset DSH environment: {account.username}</h2>
    <p>The instance will stop. Its DSH configuration and user plugins will be backed up privately, then reset to platform defaults. Projects, chats and other personal files stay in the same user space. An instance will be created if needed.</p>
    {error && <p role="alert" className="message error">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); if (confirmed) void onConfirm(); }}>
      <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required disabled={busy}/>I understand that running tasks will be interrupted.</label>
      <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="danger" type="submit" disabled={busy || !confirmed}>{busy ? 'Resetting…' : 'Reset environment'}</button></div>
    </form>
  </dialog>;
}
