import { useEffect, useRef, useState, type ComponentProps } from 'react';
import type { CommunityAccountActionRequest, CommunityAccountView, CommunityAccountsPageData, CommunityManagementSession, CommunityEnvironmentBackup } from '../../src/domain/admin-contract';
import { actOnCommunityAccount, communityAccounts, resetCommunityEnvironment } from './community-api';
import CommunityAccountActionDialog from './CommunityAccountActionDialog';
import CommunityEnvironmentResetDialog from './CommunityEnvironmentResetDialog';
import CommunityAccountDrawer from './CommunityAccountDrawer';
import { Button } from '@heroui/react/button';
import { Dropdown } from '@heroui/react/dropdown';
import { Label } from '@heroui/react/label';

type AccountSelection = ComponentProps<typeof CommunityAccountActionDialog>['selection'];

export default function CommunityAccountsPage({ session }: { session?: CommunityManagementSession }) {
  const submitting = useRef(false);
  const [editing, setEditing] = useState<CommunityAccountView | 'new'>();
  const [accounts, setAccounts] = useState<CommunityAccountsPageData>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selection, setSelection] = useState<AccountSelection>();
  const [resetSelection, setResetSelection] = useState<CommunityAccountView>();
  const [backup, setBackup] = useState<CommunityEnvironmentBackup>();
  const enabledAdmins = accounts?.items.filter(account => account.admin && !account.disabled).length ?? 0;
  const choose = (account: CommunityAccountView, request: AccountSelection['request']) => {
    setError(undefined); setNotice(undefined); setSelection({ account, request });
  };
  useEffect(() => {
    const controller = new AbortController();
    void communityAccounts(controller.signal).then(setAccounts)
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load accounts'); });
    return () => controller.abort();
  }, []);

  const confirm = async (input: CommunityAccountActionRequest) => {
    if (!selection || submitting.current) return;
    submitting.current = true;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const result = await actOnCommunityAccount(selection.account.username, input);
      if (selection.account.username === session?.username && (result.kind === 'deleted' || result.account.disabled || !result.account.admin)) {
        window.location.assign(result.kind === 'deleted' || result.account.disabled ? '/login' : '/'); return;
      }
      setSelection(undefined);
      setNotice(result.kind === 'deleted' ? `Account ${result.username} deleted. User-space files were preserved.`
        : input.action === 'reset-password' ? `Password reset for ${result.account.username}. All old logins are invalid.` : `Account ${result.account.username} updated.`);
      setAccounts(await communityAccounts());
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to update account'); }
    finally { submitting.current = false; setBusy(false); }
  };
  const resetEnvironment = async () => {
    if (!resetSelection || submitting.current) return;
    submitting.current = true;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const result = await resetCommunityEnvironment(resetSelection.username);
      setBackup(result.backup);
      if ('phase' in result) { setError(result.error); return; }
      setResetSelection(undefined); setNotice(`DSH environment reset for ${result.username}. Projects, chats and personal files were preserved. Space URL: ${result.entry}`);
      setAccounts(await communityAccounts());
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to reset DSH environment'); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <div className="community-page">
    <section className="page-title"><p className="eyebrow">ADMINISTRATION</p><h1>Account management</h1><p>Give each teammate their own DSH user space.</p></section>
    {session?.modelState === 'unconfigured' && <p className="message model-notice">Shared models are not configured. Member workspaces and terminals remain available.</p>}
    {error && !selection && !resetSelection && <p role="alert" className="message error">{error}</p>}
    {notice && <p role="status" className="message success">{notice}</p>}
    {backup && <section className="panel" aria-label="Environment backup"><h2>Environment backup</h2><pre>{backup.location}</pre><p>{backup.restoreInstructions}</p></section>}
    <section className="panel account-list" aria-label="Accounts">
      <div className="panel-heading"><div><h2>Accounts</h2><p>{accounts?.total ?? '—'} total</p></div><Button isDisabled={busy || !accounts} onPress={() => { setError(undefined); setEditing('new'); }}>Add account</Button></div>
      {!accounts ? <p>Loading accounts…</p> : <div className="table-scroll" tabIndex={0} aria-label="Scrollable account table"><table><thead><tr><th>User</th><th>Username</th><th>Role</th><th>Account status</th><th>Instance status</th><th>Actions</th></tr></thead><tbody>
        {accounts.items.map(account => {
          const lastAdmin = account.admin && !account.disabled && enabledAdmins === 1;
          return <tr key={account.username}><td><div className="user-identity"><span className="avatar" aria-hidden="true">{account.username.slice(0, 1).toUpperCase()}</span><span>{account.email || 'No email'}</span></div></td><td className="username-cell">{account.username}</td><td><span className={account.admin ? 'badge admin' : 'badge'}>{account.admin ? 'Admin' : 'Member'}</span></td><td><span className="badge">{account.disabled ? 'Disabled' : 'Enabled'}</span></td><td><span className="badge">{account.instance.state}</span></td><td>
            <div className="account-actions"><Button variant="secondary" size="sm" isDisabled={busy} aria-label={`Edit ${account.username}`} onPress={() => { setError(undefined); setEditing(account); }}>Edit</Button>
              <Button variant="tertiary" size="sm" isDisabled={busy || lastAdmin} aria-label={`${account.disabled ? 'Enable' : 'Disable'} ${account.username}`} onPress={() => choose(account, { action: 'set-disabled', disabled: !account.disabled })}>{account.disabled ? 'Enable' : 'Disable'}</Button>
              <Dropdown><Button size="sm" variant="ghost" isDisabled={busy} aria-label={`More actions for ${account.username}`}>•••</Button><Dropdown.Popover><Dropdown.Menu aria-label={`Actions for ${account.username}`} onAction={key => {
                if (key === 'password') choose(account, { action: 'reset-password', password: '' });
                else if (key === 'role') choose(account, { action: 'set-admin', admin: !account.admin });
                else if (key === 'delete') choose(account, { action: 'delete' });
                else if (key === 'environment') { setError(undefined); setNotice(undefined); setBackup(undefined); setResetSelection(account); }
              }}>
                <Dropdown.Item id="password" textValue={`Reset password for ${account.username}`}><Label>Reset password for {account.username}</Label></Dropdown.Item>
                <Dropdown.Item id="role" isDisabled={lastAdmin} textValue={account.admin ? `Remove administrator role from ${account.username}` : `Make ${account.username} an administrator`}><Label>{account.admin ? `Remove administrator role from ${account.username}` : `Make ${account.username} an administrator`}</Label></Dropdown.Item>
                <Dropdown.Item id="environment" isDisabled={account.disabled} textValue={`Reset DSH environment for ${account.username}`}><Label>Reset DSH environment for {account.username}</Label></Dropdown.Item>
                <Dropdown.Item id="delete" isDisabled={lastAdmin} variant="danger" textValue={`Delete ${account.username}`}><Label>Delete {account.username}</Label></Dropdown.Item>
              </Dropdown.Menu></Dropdown.Popover></Dropdown>
            </div>{lastAdmin ? <p className="protected-admin">Last enabled administrator</p> : null}
          </td></tr>;
        })}
      </tbody></table></div>}
    </section>
    {editing ? <CommunityAccountDrawer account={editing} onClose={() => setEditing(undefined)} onSaved={(saved, created) => {
      setAccounts(previous => { if (!previous) return previous; const items = created ? [...previous.items, saved].sort((a, b) => a.username.localeCompare(b.username)) : previous.items.map(row => row.username === saved.username ? saved : row); return { ...previous, items, total: items.length }; });
      setEditing(undefined); setNotice(created ? `Account ${saved.username} created.` : `Email saved for ${saved.username}.`);
    }}/> : null}
    {resetSelection && <CommunityEnvironmentResetDialog account={resetSelection} busy={busy} error={error} onCancel={() => { setResetSelection(undefined); setError(undefined); }} onConfirm={resetEnvironment}/>}
    {selection && <CommunityAccountActionDialog selection={selection} busy={busy} error={error} onCancel={() => { setSelection(undefined); setError(undefined); }} onConfirm={confirm}/>}
  </div>;
}
