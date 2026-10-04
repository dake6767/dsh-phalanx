import { useEffect, useRef, useState } from 'react';
import type { CommunityAccountActionRequest, CommunityAccountView } from '../../src/domain/admin-contract';

interface AccountSelection { readonly account: CommunityAccountView; readonly request: CommunityAccountActionRequest }

export default function CommunityAccountActionDialog({ selection, busy, error, onCancel, onConfirm }: {
  selection: AccountSelection; busy: boolean; error?: string;
  onCancel: () => void; onConfirm: (input: CommunityAccountActionRequest) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [password, setPassword] = useState('');
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const { account, request } = selection;
  const title = request.action === 'reset-password' ? 'Reset password'
    : request.action === 'delete' ? 'Delete account'
    : request.action === 'set-disabled' ? request.disabled ? 'Disable account' : 'Enable account'
    : request.admin ? 'Make administrator' : 'Remove administrator role';
  const explanation = request.action === 'delete'
    ? 'Access will end and the user instance will stop. User-space files will be preserved. A new account with this username will receive a separate user space.'
    : request.action === 'reset-password' ? 'All existing logins will be signed out. The running user instance will be retained.'
    : request.action === 'set-disabled' ? request.disabled ? 'All existing logins will be signed out and the user instance will stop.' : 'The member can sign in again. Previously revoked logins remain invalid.'
    : request.admin ? 'This account will be able to manage all accounts.' : 'This account will lose access to account management.';
  return <dialog ref={dialog} className="account-dialog" aria-labelledby="account-action-title"
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="account-action-title">{title}: {account.username}</h2><p>{explanation}</p>
    {error && <p role="alert" className="message error">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); void onConfirm(request.action === 'reset-password' ? { action: request.action, password } : request); }}>
      {request.action === 'reset-password' && <label>New password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" required disabled={busy}/></label>}
      <div className="dialog-actions"><button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className={request.action === 'delete' ? 'danger' : undefined} disabled={busy}>{busy ? 'Applying…' : 'Confirm action'}</button></div>
    </form>
  </dialog>;
}
