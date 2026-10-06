import { useEffect, useState, type ComponentProps, type FormEvent } from 'react';
import type { CommunityAccountActionRequest, CommunityAccountView, CommunityAccountsPageData, CommunityManagementSession, CommunityEnvironmentBackup } from '../../src/domain/admin-contract';
import { actOnCommunityAccount, communityAccounts, communitySession, createCommunityAccount, resetCommunityEnvironment } from './community-api';
import CommunityAccountActionDialog from './CommunityAccountActionDialog';
import CommunityEnvironmentResetDialog from './CommunityEnvironmentResetDialog';
import CommunitySystemUpdatePanel from './CommunitySystemUpdatePanel';
import CommunityModelsPanel from './CommunityModelsPanel';

type AccountSelection = ComponentProps<typeof CommunityAccountActionDialog>['selection'];

export default function CommunityAccountsPage() {
  const [session, setSession] = useState<CommunityManagementSession>();
  const [accounts, setAccounts] = useState<CommunityAccountsPageData>();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selection, setSelection] = useState<AccountSelection>();
  const [resetSelection, setResetSelection] = useState<CommunityAccountView>();
  const [backup, setBackup] = useState<CommunityEnvironmentBackup>();
  const enabledAdmins = accounts?.items.filter(account => account.admin && !account.disabled).length ?? 0;
  const choose = (account: CommunityAccountView, request: CommunityAccountActionRequest) => {
    setError(undefined); setNotice(undefined); setSelection({ account, request });
  };
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([communitySession(controller.signal), communityAccounts(controller.signal)])
      .then(([viewer, page]) => { setSession(viewer); setAccounts(page); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load accounts'); });
    return () => controller.abort();
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const created = await createCommunityAccount({ username, email, password });
      setPassword(''); setUsername(''); setEmail('');
      setNotice(`Account ${created.username} created.`);
      setAccounts(await communityAccounts());
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to create account'); }
    finally { setBusy(false); }
  };
  const confirm = async (input: CommunityAccountActionRequest) => {
    if (!selection) return;
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
    finally { setBusy(false); }
  };
  const resetEnvironment = async () => {
    if (!resetSelection) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const result = await resetCommunityEnvironment(resetSelection.username);
      setBackup(result.backup);
      if ('phase' in result) { setError(result.error); return; }
      setResetSelection(undefined); setNotice(`DSH environment reset for ${result.username}. Projects, chats and personal files were preserved. Space URL: ${result.entry}`);
      setAccounts(await communityAccounts());
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to reset DSH environment'); }
    finally { setBusy(false); }
  };
  return <main className="community-page">
    <header><a className="wordmark" href="/admin">dsh-phalanx</a><div className="header-actions">
      <a href="#model-settings">Model settings</a>{session?.admin && <a href="#system-update">System update</a>}<a href="/enter">Open DSH</a><span>{session?.username}</span><form method="post" action="/logout"><button className="secondary" type="submit">Sign out</button></form>
    </div></header>
    <section className="page-title"><p className="eyebrow">ADMINISTRATION</p><h1>Account management</h1><p>Give each teammate their own DSH user space.</p></section>
    {session?.modelState === 'unconfigured' && <p className="message model-notice">Shared models are not configured. Member workspaces and terminals remain available.</p>}
    {error && !selection && !resetSelection && <p role="alert" className="message error">{error}</p>}
    {notice && <p role="status" className="message success">{notice}</p>}
    {backup && <section className="panel" aria-label="Environment backup"><h2>Environment backup</h2><pre>{backup.location}</pre><p>{backup.restoreInstructions}</p></section>}
    <div className="account-layout"><section className="panel account-list" aria-label="Accounts">
      <div className="panel-heading"><h2>Accounts</h2><span>{accounts?.total ?? '—'} total</span></div>
      {!accounts ? <p>Loading accounts…</p> : <div className="table-scroll"><table><thead><tr><th>Username</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        {accounts.items.map(account => {
          const lastAdmin = account.admin && !account.disabled && enabledAdmins === 1;
          return <tr key={account.username}><td>{account.username}</td><td>{account.email}</td><td><span className={account.admin ? 'badge admin' : 'badge'}>{account.admin ? 'Admin' : 'Member'}</span></td><td>{account.disabled ? 'Disabled' : 'Enabled'}</td><td>
            <div className="account-actions">
              <button className="secondary" disabled={busy} aria-label={`Reset password for ${account.username}`} onClick={() => choose(account, { action: 'reset-password', password: '' })}>Reset password</button>
              <button className="secondary" disabled={busy || lastAdmin} aria-label={`${account.disabled ? 'Enable' : 'Disable'} ${account.username}`} onClick={() => choose(account, { action: 'set-disabled', disabled: !account.disabled })}>{account.disabled ? 'Enable' : 'Disable'}</button>
              <button className="secondary" disabled={busy || lastAdmin} aria-label={account.admin ? `Remove administrator role from ${account.username}` : `Make ${account.username} an administrator`} onClick={() => choose(account, { action: 'set-admin', admin: !account.admin })}>{account.admin ? 'Remove admin' : 'Make admin'}</button>
              <button className="secondary" disabled={busy || account.disabled} aria-label={`Reset DSH environment for ${account.username}`} onClick={() => { setError(undefined); setNotice(undefined); setBackup(undefined); setResetSelection(account); }}>Reset DSH environment</button>
              <button className="secondary danger" disabled={busy || lastAdmin} aria-label={`Delete ${account.username}`} onClick={() => choose(account, { action: 'delete' })}>Delete</button>
            </div>{lastAdmin && <p className="protected-admin">Last enabled administrator: disable, delete and role removal are unavailable.</p>}
          </td></tr>;
        })}
      </tbody></table></div>}
    </section><section className="panel create-account"><h2>Create a member</h2><p>Share the username and temporary password privately.</p>
      <form onSubmit={event => { void submit(event); }}>
        <label>Username<input value={username} onChange={event => setUsername(event.target.value)} pattern="[a-z0-9][a-z0-9_-]{0,63}" autoComplete="off" required disabled={busy}/></label>
        <label>Email<input value={email} onChange={event => setEmail(event.target.value)} type="email" autoComplete="off" required disabled={busy}/></label>
        <label>Temporary password<input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="new-password" required disabled={busy}/></label>
        <button type="submit" disabled={busy || !accounts}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>
    </section></div>
    <CommunityModelsPanel onConfigured={configured => setSession(viewer => viewer && { ...viewer, modelState: configured ? 'configured' : 'unconfigured' })}/>
    {session?.admin && <CommunitySystemUpdatePanel/>}
    {resetSelection && <CommunityEnvironmentResetDialog account={resetSelection} busy={busy} error={error} onCancel={() => { setResetSelection(undefined); setError(undefined); }} onConfirm={resetEnvironment}/>}
    {selection && <CommunityAccountActionDialog selection={selection} busy={busy} error={error} onCancel={() => { setSelection(undefined); setError(undefined); }} onConfirm={confirm}/>}
  </main>;
}
