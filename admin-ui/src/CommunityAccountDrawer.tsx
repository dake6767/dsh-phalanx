import type { CommunityGroupView } from '../../src/domain/admin-contract';
import CommunitySelect from './CommunitySelect';
import { communityGroupLabel } from './community-group-label';
import { usePlatformLanguage, CommunityCopyError } from './CommunityLanguage';
import { useId, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityAccountView } from '../../src/domain/admin-contract';
import { actOnCommunityAccount, createCommunityAccount } from './community-api';
import CommunityDialog from './CommunityDialog';
import CommunityField from './CommunityField';
import { useDraftGuard } from './useDraftGuard';
import CommunityMessage from './CommunityMessage';
export default function CommunityAccountDrawer({ account, groups, onClose, onSaved }: {
  groups: readonly CommunityGroupView[]; account: CommunityAccountView | 'new'; onClose: () => void; onSaved: (account: CommunityAccountView, created: boolean) => void;
}) {
  const { t, errorText } = usePlatformLanguage();
  const creating = account === 'new';
  const initialGroup = creating ? groups.find(group => group.isDefault)?.id ?? '' : account.groupId;
  const [groupId, setGroupId] = useState(initialGroup);
  const [username, setUsername] = useState(creating ? '' : account.username);
  const [email, setEmail] = useState(creating ? '' : account.email);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const formId = useId();
  const dirty = creating ? Boolean(username || email || password || groupId !== initialGroup) : email !== account.email || groupId !== account.groupId;
  const save = async () => {
    if (submitting.current) return false;
    if (!form.current?.checkValidity()) { setError(new CommunityCopyError("Complete the required fields and enter a valid email.")); return false; }
    submitting.current = true; setBusy(true); setError(undefined);
    try {
      const result = creating ? await createCommunityAccount({ username, email, password, groupId }) : await actOnCommunityAccount(account.username, { action: 'set-email', email, groupId });
      if ('kind' in result) { if (result.kind !== 'updated') return false; onSaved(result.account, false); }
      else onSaved(result, true);
      setPassword(''); return true;
    } catch (failure) { setError(failure); return false; }
    finally { submitting.current = false; setBusy(false); }
  };
  const guard = useDraftGuard(dirty, save, () => { setEmail(creating ? '' : account.email); setUsername(creating ? '' : account.username); setPassword(''); setGroupId(initialGroup); }, busy);
  return <><CommunityDialog title={creating ? t("Create a member") : t("Edit account: {username}", { username: account.username })} busy={busy} drawer eyebrow={t("ACCOUNT DETAILS")} onClose={() => guard.request(onClose)}
    footer={<><Button variant="tertiary" type="button" isDisabled={busy} onPress={() => guard.request(onClose)}>{t("Cancel")}</Button><Button type="submit" form={formId} isDisabled={busy || (!creating && !dirty)}>{busy ? t("Saving…") : creating ? t("Create account") : t("Save changes")}</Button></>}>
    <p className="drawer-description">{creating ? t("Share the username and temporary password privately.") : t("Change the contact email and group.")}</p>
    {!creating && <div className="drawer-identity"><span className={`avatar tone-${account.username.charCodeAt(0) % 4}`} aria-hidden="true">{account.username.slice(0, 1).toUpperCase()}</span><div><strong>{account.username}</strong><span>{account.admin ? t("Administrator") : t("Member")}</span></div><span className={`account-state ${account.disabled ? 'is-disabled' : 'is-enabled'}`}><span aria-hidden="true"/>{account.disabled ? t("Disabled") : t("Enabled")}</span></div>}
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <form ref={form} id={formId} onSubmit={event => { event.preventDefault(); void save(); }} className="account-form">
      <CommunityField label={t("Username")} value={username} onChange={setUsername} readOnly={!creating} disabled={busy} required autoFocus={creating} pattern="[a-z0-9][a-z0-9_-]{0,63}"/>
      <CommunityField label={t("Email")} value={email} onChange={setEmail} type="email" disabled={busy} required={creating || account.email !== ''} autoFocus={!creating}/>
      <CommunitySelect label={t('Group')} value={groupId} onChange={setGroupId} disabled={busy || (!creating && account.admin)} options={groups.filter(group => !creating && account.admin ? group.kind === 'admin' : group.kind === 'ordinary').map(group => ({ id: group.id, label: communityGroupLabel(group, t) }))}/>
      {creating ? <CommunityField label={t("Temporary password")} value={password} onChange={setPassword} type="password" autoComplete="new-password" disabled={busy} required/> : <section className="drawer-space"><h3>{t("User space")}</h3><dl className="account-details"><dt>{t("Space ID")}</dt><dd className="space-id">{account.spaceId}</dd><dt>{t("Instance status")}</dt><dd><span className={`instance-state state-${account.instance.state}`}><span aria-hidden="true"/>{t(account.instance.state)}</span></dd></dl></section>}
    </form>
  </CommunityDialog>{guard.dialog}</>;
}
