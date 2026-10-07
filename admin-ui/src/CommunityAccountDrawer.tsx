import { useId, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityAccountView } from '../../src/domain/admin-contract';
import { actOnCommunityAccount, createCommunityAccount } from './community-api';
import CommunityDialog from './CommunityDialog';
import CommunityField from './CommunityField';
import { useDraftGuard } from './useDraftGuard';
import CommunityMessage from './CommunityMessage';
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
  const formId = useId();
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
  return <><CommunityDialog title={creating ? 'Create a member' : `Edit account: ${account.username}`} busy={busy} drawer eyebrow="ACCOUNT DETAILS" onClose={() => guard.request(onClose)}
    footer={<><Button variant="tertiary" type="button" isDisabled={busy} onPress={() => guard.request(onClose)}>Cancel</Button><Button type="submit" form={formId} isDisabled={busy || (!creating && !dirty)}>{busy ? 'Saving…' : creating ? 'Create account' : 'Save email'}</Button></>}>
    <p className="drawer-description">{creating ? 'Share the username and temporary password privately.' : 'Change the contact email. Other account actions are performed separately from the account list.'}</p>
    {!creating && <div className="drawer-identity"><span className={`avatar tone-${account.username.charCodeAt(0) % 4}`} aria-hidden="true">{account.username.slice(0, 1).toUpperCase()}</span><div><strong>{account.username}</strong><span>{account.admin ? 'Administrator' : 'Member'}</span></div><span className={`account-state ${account.disabled ? 'is-disabled' : 'is-enabled'}`}><span aria-hidden="true"/>{account.disabled ? 'Disabled' : 'Enabled'}</span></div>}
    {error ? <CommunityMessage role="alert" status="danger" title={error}/> : null}
    <form ref={form} id={formId} onSubmit={event => { event.preventDefault(); void save(); }} className="account-form">
      <CommunityField label="Username" value={username} onChange={setUsername} readOnly={!creating} disabled={busy} required autoFocus={creating} pattern="[a-z0-9][a-z0-9_-]{0,63}"/>
      <CommunityField label="Email" value={email} onChange={setEmail} type="email" disabled={busy} required autoFocus={!creating}/>
      {creating ? <CommunityField label="Temporary password" value={password} onChange={setPassword} type="password" autoComplete="new-password" disabled={busy} required/> : <section className="drawer-space"><h3>User space</h3><dl className="account-details"><dt>Space ID</dt><dd className="space-id">{account.spaceId}</dd><dt>Instance status</dt><dd><span className={`instance-state state-${account.instance.state}`}><span aria-hidden="true"/>{account.instance.state}</span></dd></dl></section>}
    </form>
  </CommunityDialog>{guard.dialog}</>;
}
