import type { PlatformMessage } from '../../src/domain/platform-copy';
import { CommunityApiRequestError } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
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
  const { t, errorText } = usePlatformLanguage();
  const submitting = useRef(false);
  const [editing, setEditing] = useState<CommunityAccountView | 'new'>();
  const [accounts, setAccounts] = useState<CommunityAccountsPageData>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState<PlatformMessage>();
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
      .catch(failure => { if (!controller.signal.aborted) setError(failure); });
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
      setNotice(result.kind === 'deleted' ? { key: "Account {username} deleted. User-space files were preserved.", params: { username: result.username } }
        : input.action === 'reset-password' ? { key: "Password reset for {username}. All old logins are invalid.", params: { username: result.account.username } } : { key: "Account {username} updated.", params: { username: result.account.username } });
      setAccounts(await communityAccounts());
    } catch (failure) { setError(failure); }
    finally { submitting.current = false; setBusy(false); }
  };
  const resetEnvironment = async () => {
    if (!resetSelection || submitting.current) return;
    submitting.current = true;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const result = await resetCommunityEnvironment(resetSelection.username);
      setBackup(result.backup);
      if ('phase' in result) { setError(new CommunityApiRequestError(result.error, 503, result.code, result.params)); return; }
      setResetSelection(undefined); setNotice({ key: "DSH environment reset for {username}. Projects, chats and personal files were preserved. Space URL: {entry}", params: { username: result.username, entry: result.entry } });
      setAccounts(await communityAccounts());
    } catch (failure) { setError(failure); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <div className="community-page">
    <section className="page-heading accounts-title"><div><h1>{t("Account management")}<span className="heading-dot" aria-hidden="true">.</span></h1><p>{t("Manage accounts, access and user instances in one place.")}</p></div><Button className="primary-action" isDisabled={busy || !accounts} onPress={() => { setError(undefined); setEditing('new'); }}><CommunityIcon name="plus" size={16}/>{t("Add account")}</Button></section>
    {error !== undefined && !selection && !resetSelection && <CommunityMessage role="alert" status="danger" title={errorText(error)}/>}
    {notice && <CommunityMessage role="status" status="success" title={t(notice.key, notice.params)}/>}
    {backup && <section className="panel" aria-label={t("Environment backup")}><h2>{t("Environment backup")}</h2><pre>{backup.location}</pre><p>{backup.restoreInstructionsPath ? t("Stop the platform service and the target container, then follow {path}. Backups are retained until the deployer removes them explicitly.", { path: backup.restoreInstructionsPath }) : backup.restoreInstructions}</p></section>}
    <div className="stat-grid" aria-label={t("Account overview")}>
      {([
        [t("Total accounts"), accounts?.total, t("Accounts on this platform"), 'accounts', 'neutral'],
        [t("Enabled"), accounts?.items.filter(account => !account.disabled).length, t("Allowed to sign in"), 'check', 'mint'],
        [t("Running instances"), accounts?.items.filter(account => account.instance.state === 'ready').length, t("Instances ready for use"), 'activity', 'blue'],
        [t("Disabled"), accounts?.items.filter(account => account.disabled).length, t("Sign-in access suspended"), 'alert', 'amber'],
      ] as const).map(([label, value, note, icon, tone]) => <section className={`metric-card ${tone}`} key={label} aria-label={label}><div className="metric-top"><span>{label}</span><span className="metric-icon"><CommunityIcon name={icon} size={20}/></span></div><strong>{value === undefined ? '—' : String(value).padStart(2, '0')}</strong><div className="metric-note"><CommunityIcon name="downright" size={14}/>{note}</div></section>)}
    </div>
    <section className="panel account-list account-panel" aria-label={t("Accounts")}>
      <div className="panel-top"><div><h2>{t("All accounts")}</h2><p>{t("Account roles and access are managed separately.")}</p></div><span className="panel-account-count">{t('{count} accounts', { count: accounts?.total ?? '—' })}</span></div>
      {!accounts ? <p className="table-empty" role="status">{t("Loading accounts…")}</p> : <div className="table-scroll" tabIndex={0} aria-label={t("Scrollable account table")}><table className="accounts-table"><thead><tr><th>{t("Account")}</th><th>{t("Role")}</th><th>{t("Account status")}</th><th>{t("Instance status")}</th><th>{t("Actions")}</th></tr></thead><tbody>
        {accounts.items.map(account => {
          const lastAdmin = account.admin && !account.disabled && enabledAdmins === 1;
          return <tr key={account.username}><td><div className="person-cell"><span className={`avatar tone-${account.username.charCodeAt(0) % 4}`} aria-hidden="true">{account.username.slice(0, 1).toUpperCase()}</span><div><strong>{account.username}</strong><span>{account.email || t("No email")}</span></div></div></td><td><span className={account.admin ? 'badge admin' : 'badge'}>{account.admin ? t("Admin") : t("Member")}</span></td><td><span className={`account-state ${account.disabled ? 'is-disabled' : 'is-enabled'}`}><span aria-hidden="true"/>{account.disabled ? t("Disabled") : t("Enabled")}</span></td><td><span className={`instance-state state-${account.instance.state}`}><span aria-hidden="true"/>{t(account.instance.state)}</span></td><td>
            <div className="account-actions"><Button variant="secondary" size="sm" isDisabled={busy} aria-label={t("Edit {username}", { username: account.username })} onPress={() => { setError(undefined); setEditing(account); }}><CommunityIcon name="edit" size={14}/>{t("Edit")}</Button>
              <Button variant="tertiary" size="sm" isDisabled={busy || lastAdmin} aria-label={t(account.disabled ? 'Enable {username}' : 'Disable {username}', { username: account.username })} onPress={() => choose(account, { action: 'set-disabled', disabled: !account.disabled })}>{account.disabled ? t("Enable") : t("Disable")}</Button>
              <Dropdown><Button size="sm" variant="ghost" isDisabled={busy} aria-label={t("More actions for {username}", { username: account.username })}><CommunityIcon name="more" size={16}/></Button><Dropdown.Popover><Dropdown.Menu aria-label={t("Actions for {username}", { username: account.username })} onAction={key => {
                if (key === 'password') choose(account, { action: 'reset-password', password: '' });
                else if (key === 'role') choose(account, { action: 'set-admin', admin: !account.admin });
                else if (key === 'delete') choose(account, { action: 'delete' });
                else if (key === 'environment') { setError(undefined); setNotice(undefined); setBackup(undefined); setResetSelection(account); }
              }}>
                <Dropdown.Item id="password" textValue={t("Reset password for {username}", { username: account.username })}><Label>{t("Reset password for {username}", { username: account.username })}</Label></Dropdown.Item>
                <Dropdown.Item id="role" isDisabled={lastAdmin} textValue={account.admin ? t("Remove administrator role from {username}", { username: account.username }) : t("Make {username} an administrator", { username: account.username })}><Label>{account.admin ? t("Remove administrator role from {username}", { username: account.username }) : t("Make {username} an administrator", { username: account.username })}</Label></Dropdown.Item>
                <Dropdown.Item id="environment" isDisabled={account.disabled} textValue={t("Reset DSH environment for {username}", { username: account.username })}><Label>{t("Reset DSH environment for {username}", { username: account.username })}</Label></Dropdown.Item>
                <Dropdown.Item id="delete" isDisabled={lastAdmin} variant="danger" textValue={t("Delete {username}", { username: account.username })}><Label>{t("Delete {username}", { username: account.username })}</Label></Dropdown.Item>
              </Dropdown.Menu></Dropdown.Popover></Dropdown>
            </div>{lastAdmin ? <p className="protected-admin">{t("Last enabled administrator")}</p> : null}
          </td></tr>;
        })}
      {accounts.items.length === 0 && <tr><td colSpan={5} className="table-empty">{t("No accounts to display.")}</td></tr>}</tbody></table></div>}
      {accounts && <div className="account-list-footer panel-footer">{t(accounts.total === 1 ? '{count} account' : '{count} accounts', { count: accounts.total })}<span>{t("Each account has an independent user space.")}</span></div>}
    </section>
    {session?.modelState === 'unconfigured' && <CommunityMessage status="accent" title={t("Shared models are not configured.")}>{t("Member workspaces and terminals remain available.")}</CommunityMessage>}
    {editing ? <CommunityAccountDrawer account={editing} onClose={() => setEditing(undefined)} onSaved={(saved, created) => {
      setAccounts(previous => { if (!previous) return previous; const items = created ? [...previous.items, saved].sort((a, b) => a.username.localeCompare(b.username)) : previous.items.map(row => row.username === saved.username ? saved : row); return { ...previous, items, total: items.length }; });
      setEditing(undefined); setNotice(created ? { key: "Account {username} created.", params: { username: saved.username } } : { key: "Email saved for {username}.", params: { username: saved.username } });
    }}/> : null}
    {resetSelection && <CommunityEnvironmentResetDialog account={resetSelection} busy={busy} error={error} onCancel={() => { setResetSelection(undefined); setError(undefined); }} onConfirm={resetEnvironment}/>}
    {selection && <CommunityAccountActionDialog selection={selection} busy={busy} error={error} onCancel={() => { setSelection(undefined); setError(undefined); }} onConfirm={confirm}/>}
  </div>;
}
