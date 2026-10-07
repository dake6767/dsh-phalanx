import { useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityAccountActionRequest, CommunityAccountView } from '../../src/domain/admin-contract';
import CommunityDialog from './CommunityDialog';
import CommunityField from './CommunityField';
interface AccountSelection { readonly account: CommunityAccountView; readonly request: Exclude<CommunityAccountActionRequest, { action: 'set-email' }> }
export default function CommunityAccountActionDialog({ selection, busy, error, onCancel, onConfirm }: {
  selection: AccountSelection; busy: boolean; error?: string; onCancel: () => void; onConfirm: (input: CommunityAccountActionRequest) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const { account, request } = selection;
  const title = request.action === 'reset-password' ? 'Reset password' : request.action === 'delete' ? 'Delete account'
    : request.action === 'set-disabled' ? request.disabled ? 'Disable account' : 'Enable account' : request.admin ? 'Make administrator' : 'Remove administrator role';
  const explanation = request.action === 'delete' ? 'Access will end and the user instance will stop. User-space files will be preserved. A new account with this username will receive a separate user space.'
    : request.action === 'reset-password' ? 'All existing logins will be signed out. The running user instance will be retained.'
    : request.action === 'set-disabled' ? request.disabled ? 'All existing logins will be signed out and the user instance will stop.' : 'The member can sign in again. Previously revoked logins remain invalid.'
    : request.admin ? 'This account will be able to manage all accounts.' : 'This account will lose access to account management.';
  return <CommunityDialog title={`${title}: ${account.username}`} busy={busy} onClose={onCancel}>
    <p>{explanation}</p>{error ? <p role="alert" className="message error">{error}</p> : null}
    <form onSubmit={event => { event.preventDefault(); if (!busy) void onConfirm(request.action === 'reset-password' ? { action: request.action, password } : request); }}>
      {request.action === 'reset-password' ? <CommunityField label="New password" value={password} onChange={setPassword} type="password" autoComplete="new-password" required disabled={busy} autoFocus/> : null}
      <div className="dialog-actions"><Button variant="tertiary" type="button" onPress={onCancel} isDisabled={busy}>Cancel</Button><Button type="submit" variant={request.action === 'delete' ? 'danger' : 'primary'} isDisabled={busy}>{busy ? 'Applying…' : 'Confirm action'}</Button></div>
    </form>
  </CommunityDialog>;
}
