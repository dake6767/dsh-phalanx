import { useEffect, useRef, useState, type ComponentProps } from 'react';
import type { CommunityAccountActionRequest, CommunityAccountView, CommunityAccountsPageData, CommunityManagementSession, CommunityEnvironmentBackup } from '../../src/domain/admin-contract';
import { actOnCommunityAccount, communityAccounts, resetCommunityEnvironment } from './community-api';
import CommunityAccountActionDialog from './CommunityAccountActionDialog';
import CommunityEnvironmentResetDialog from './CommunityEnvironmentResetDialog';
import CommunityAccountDrawer from './CommunityAccountDrawer';
import { Button } from '@heroui/react/button';
import { Dropdown } from '@heroui/react/dropdown';
import CommunityIcon from './CommunityIcon';
import { Label } from '@heroui/react/label';
import CommunityMessage from './CommunityMessage';

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
    <section className="page-heading accounts-title"><div><h1>Account management<span className="heading-dot" aria-hidden="true">.</span></h1><p>Manage accounts, access and user instances in one place.</p></div><Button className="primary-action" isDisabled={busy || !accounts} onPress={() => { setError(undefined); setEditing('new'); }}><CommunityIcon name="plus" size={16}/>Add account</Button></section>
    {error && !selection && !resetSelection && <CommunityMessage role="alert" status="danger" title={error}/>}
    {notice && <CommunityMessage role="status" status="success" title={notice}/>}
    {backup && <section className="panel" aria-label="Environment backup"><h2>Environment backup</h2><pre>{backup.location}</pre><p>{backup.restoreInstructions}</p></section>}
    <div className="stat-grid" aria-label="Account overview">
      {([
        ['Total accounts', accounts?.total, 'Accounts on this platform', 'accounts', 'neutral'],
        ['Enabled', accounts?.items.filter(account => !account.disabled).length, 'Allowed to sign in', 'check', 'mint'],
        ['Running instances', accounts?.items.filter(account => account.instance.state === 'ready').length, 'Instances ready for use', 'activity', 'blue'],
        ['Disabled', accounts?.items.filter(account => account.disabled).length, 'Sign-in access suspended', 'alert', 'amber'],
      ] as const).map(([label, value, note, icon, tone]) => <section className={`metric-card ${tone}`} key={label} aria-label={label}><div className="metric-top"><span>{label}</span><span className="metric-icon"><CommunityIcon name={icon} size={20}/></span></div><strong>{value === undefined ? '—' : String(value).padStart(2, '0')}</strong><div className="metric-note"><CommunityIcon name="downright" size={14}/>{note}</div></section>)}
    </div>
    <section className="panel account-list account-panel" aria-label="Accounts">
      <div className="panel-top"><div><h2>All accounts</h2><p>Account roles and access are managed separately.</p></div><span className="panel-account-count">{accounts?.total ?? '—'} accounts</span></div>
      {!accounts ? <p className="table-empty" role="status">Loading accounts…</p> : <div className="table-scroll" tabIndex={0} aria-label="Scrollable account table"><table className="accounts-table"><thead><tr><th>Account</th><th>Role</th><th>Account status</th><th>Instance status</th><th>Actions</th></tr></thead><tbody>
        {accounts.items.map(account => {
          const lastAdmin = account.admin && !account.disabled && enabledAdmins === 1;
          return <tr key={account.username}><td><div className="person-cell"><span className={`avatar tone-${account.username.charCodeAt(0) % 4}`} aria-hidden="true">{account.username.slice(0, 1).toUpperCase()}</span><div><strong>{account.username}</strong><span>{account.email || 'No email'}</span></div></div></td><td><span className={account.admin ? 'badge admin' : 'badge'}>{account.admin ? 'Admin' : 'Member'}</span></td><td><span className={`account-state ${account.disabled ? 'is-disabled' : 'is-enabled'}`}><span aria-hidden="true"/>{account.disabled ? 'Disabled' : 'Enabled'}</span></td><td><span className={`instance-state state-${account.instance.state}`}><span aria-hidden="true"/>{account.instance.state}</span></td><td>
            <div className="account-actions"><Button variant="secondary" size="sm" isDisabled={busy} aria-label={`Edit ${account.username}`} onPress={() => { setError(undefined); setEditing(account); }}><CommunityIcon name="edit" size={14}/>Edit</Button>
              <Button variant="tertiary" size="sm" isDisabled={busy || lastAdmin} aria-label={`${account.disabled ? 'Enable' : 'Disable'} ${account.username}`} onPress={() => choose(account, { action: 'set-disabled', disabled: !account.disabled })}>{account.disabled ? 'Enable' : 'Disable'}</Button>
              <Dropdown><Button size="sm" variant="ghost" isDisabled={busy} aria-label={`More actions for ${account.username}`}><CommunityIcon name="more" size={16}/></Button><Dropdown.Popover><Dropdown.Menu aria-label={`Actions for ${account.username}`} onAction={key => {
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
      {accounts.items.length === 0 && <tr><td colSpan={5} className="table-empty">No accounts to display.</td></tr>}</tbody></table></div>}
      {accounts && <div className="account-list-footer panel-footer">{accounts.total} {accounts.total === 1 ? 'account' : 'accounts'}<span>Each account has an independent user space.</span></div>}
    </section>
    {session?.modelState === 'unconfigured' && <CommunityMessage status="accent" title="Shared models are not configured.">Member workspaces and terminals remain available.</CommunityMessage>}
    {editing ? <CommunityAccountDrawer account={editing} onClose={() => setEditing(undefined)} onSaved={(saved, created) => {
      setAccounts(previous => { if (!previous) return previous; const items = created ? [...previous.items, saved].sort((a, b) => a.username.localeCompare(b.username)) : previous.items.map(row => row.username === saved.username ? saved : row); return { ...previous, items, total: items.length }; });
      setEditing(undefined); setNotice(created ? `Account ${saved.username} created.` : `Email saved for ${saved.username}.`);
    }}/> : null}
    {resetSelection && <CommunityEnvironmentResetDialog account={resetSelection} busy={busy} error={error} onCancel={() => { setResetSelection(undefined); setError(undefined); }} onConfirm={resetEnvironment}/>}
    {selection && <CommunityAccountActionDialog selection={selection} busy={busy} error={error} onCancel={() => { setSelection(undefined); setError(undefined); }} onConfirm={confirm}/>}
  </div>;
}
