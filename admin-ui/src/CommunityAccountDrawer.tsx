import { useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityAccountView } from '../../src/domain/admin-contract';
import { actOnCommunityAccount, createCommunityAccount } from './community-api';
import CommunityDialog from './CommunityDialog';
import CommunityField from './CommunityField';
import { useDraftGuard } from './useDraftGuard';
export default function CommunityAccountDrawer({ account, onClose, onSaved }: {
  account: CommunityAccountView | 'new'; onClose: () => void; onSaved: (account: CommunityAccountView, created: boolean) => void;
}) {
  const creating = account === 'new';
  const [username, setUsername] = useState(creating ? '' : account.username);
  const [email, setEmail] = useState(creating ? '' : account.email);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const dirty = creating ? Boolean(username || email || password) : email !== account.email;
  const save = async () => {
    if (submitting.current) return false;
    if (!form.current?.checkValidity()) { setError('Complete the required fields and enter a valid email.'); return false; }
    submitting.current = true; setBusy(true); setError(undefined);
    try {
      const result = creating ? await createCommunityAccount({ username, email, password }) : await actOnCommunityAccount(account.username, { action: 'set-email', email });
      if ('kind' in result) { if (result.kind !== 'updated') return false; onSaved(result.account, false); }
      else onSaved(result, true);
      setPassword(''); return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to save account'); return false; }
    finally { submitting.current = false; setBusy(false); }
  };
  const guard = useDraftGuard(dirty, save, () => { setEmail(creating ? '' : account.email); setUsername(creating ? '' : account.username); setPassword(''); }, busy);
  return <><CommunityDialog title={creating ? 'Create a member' : `Edit account: ${account.username}`} busy={busy} drawer onClose={() => guard.request(onClose)}>
    <p>{creating ? 'Share the username and temporary password privately.' : 'Change the contact email. Other account actions are performed separately from the account list.'}</p>
    {error ? <p role="alert" className="message error">{error}</p> : null}
    <form ref={form} onSubmit={event => { event.preventDefault(); void save(); }} className="account-form">
      <CommunityField label="Username" value={username} onChange={setUsername} readOnly={!creating} disabled={busy} required autoFocus={creating} pattern="[a-z0-9][a-z0-9_-]{0,63}"/>
      <CommunityField label="Email" value={email} onChange={setEmail} type="email" disabled={busy} required autoFocus={!creating}/>
      {creating ? <CommunityField label="Temporary password" value={password} onChange={setPassword} type="password" autoComplete="new-password" disabled={busy} required/> : <dl className="account-details"><dt>User space ID</dt><dd>{account.spaceId}</dd><dt>Role</dt><dd>{account.admin ? 'Admin' : 'Member'}</dd><dt>Account status</dt><dd>{account.disabled ? 'Disabled' : 'Enabled'}</dd><dt>Instance status</dt><dd>{account.instance.state}</dd></dl>}
      <div className="dialog-actions"><Button variant="tertiary" type="button" isDisabled={busy} onPress={() => guard.request(onClose)}>Cancel</Button><Button type="submit" isDisabled={busy || (!creating && !dirty)}>{busy ? 'Saving…' : creating ? 'Create account' : 'Save email'}</Button></div>
    </form>
  </CommunityDialog>{guard.dialog}</>;
}
