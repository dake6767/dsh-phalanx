import { useMemberInstanceResources } from './useMemberInstanceResources';
import CommunityMemberInstanceResources from './CommunityMemberInstanceResources';
import type { CommunityGroupView } from '../../src/domain/admin-contract';
import CommunitySelect from './CommunitySelect';
import { communityGroupLabel } from './community-group-label';
import { usePlatformLanguage, CommunityCopyError } from './CommunityLanguage';
import { useId, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Avatar } from '@heroui/react/avatar';
import type { CommunityAccountView } from '../../src/domain/admin-contract';
import { actOnCommunityAccount, createCommunityAccount, communityAccounts, CommunityApiRequestError } from './community-api';
import CommunityDialog from './CommunityDialog';
import CommunityField from './CommunityField';
import { useDraftGuard } from './useDraftGuard';
import CommunityMessage from './CommunityMessage';
export default function CommunityAccountDrawer({ account, groups, onClose, onSaved, onResourcesChanged }: {
  groups: readonly CommunityGroupView[]; account: CommunityAccountView | 'new'; onClose: () => void; onSaved: (account: CommunityAccountView, created: boolean, close?: boolean) => void; onResourcesChanged?: () => void;
}) {
  const { t, errorText } = usePlatformLanguage();
  const creating = account === 'new';
  const resources = useMemberInstanceResources(creating ? undefined : account.username, onResourcesChanged);
  const initialGroup = creating ? groups.find(group => group.isDefault)?.id ?? '' : account.groupId;
  const [groupId, setGroupId] = useState(initialGroup);
  const [username, setUsername] = useState(creating ? '' : account.username);
  const [email, setEmail] = useState(creating ? '' : account.email);
  const [password, setPassword] = useState('');
  const [saving, setBusy] = useState(false);
  const busy = saving || resources.busy;
  const [error, setError] = useState<unknown>();
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const formId = useId();
  const accountDirty = creating ? Boolean(username || email || password || groupId !== initialGroup) : email !== account.email || groupId !== account.groupId;
  const dirty = accountDirty || resources.dirty;
  const save = async (close = true) => {
    if (submitting.current) return false;
    if (!form.current?.checkValidity()) { setError(new CommunityCopyError("Complete the required fields and enter a valid email.")); return false; }
    submitting.current = true; setBusy(true); setError(undefined);
    try {
      if (!creating && !await resources.save()) return false;
      if (creating || accountDirty) {
        const result = creating ? await createCommunityAccount({ username, email, password, groupId }) : await actOnCommunityAccount(account.username, { action: 'set-email', email, groupId });
        if ('kind' in result) { if (result.kind !== 'updated') return false; onSaved(result.account, false, close); }
        else onSaved(result, true, close);
      } else {
        const updated = (await communityAccounts()).items.find(row => row.username === account.username);
        if (!updated) throw new CommunityApiRequestError('Account not found.', 404, 'account-not-found');
        onSaved(updated, false, close);
      }
      setPassword(''); return true;
    } catch (failure) { setError(failure); return false; }
    finally { submitting.current = false; setBusy(false); }
  };
  const guard = useDraftGuard(dirty, () => save(false), () => { resources.discard(); setEmail(creating ? '' : account.email); setUsername(creating ? '' : account.username); setPassword(''); setGroupId(initialGroup); }, busy);
  return <><CommunityDialog title={creating ? t("Create a member") : t("Edit account: {username}", { username: account.username })} busy={busy} drawer eyebrow={t("ACCOUNT DETAILS")} onClose={() => guard.request(onClose)}
    footer={<><Button variant="tertiary" type="button" isDisabled={busy} onPress={() => guard.request(onClose)}>{t("Cancel")}</Button><Button type="submit" form={formId} isDisabled={busy || (!creating && !dirty)}>{busy ? t("Saving…") : creating ? t("Create account") : t("Save changes")}</Button></>}>
    <p className="drawer-description">{creating ? t("Share the username and temporary password privately.") : t("Change the contact email and group.")}</p>
    {!creating && <div className="drawer-identity"><Avatar variant="soft" color={(['accent', 'success', 'warning', 'danger'] as const)[account.username.charCodeAt(0) % 4]} aria-hidden="true"><Avatar.Fallback>{account.username.slice(0, 1).toUpperCase()}</Avatar.Fallback></Avatar><div><strong>{account.username}</strong><span>{account.admin ? t("Administrator") : t("Member")}</span></div><span className={`account-state ${account.disabled ? 'is-disabled' : 'is-enabled'}`}><span aria-hidden="true"/>{account.disabled ? t("Disabled") : t("Enabled")}</span></div>}
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <form ref={form} id={formId} onSubmit={event => { event.preventDefault(); void save(); }} className="account-form">
      <CommunityField label={t("Username")} value={username} onChange={setUsername} readOnly={!creating} disabled={busy} required autoFocus={creating} pattern="[a-z0-9][a-z0-9_-]{0,63}"/>
      <CommunityField label={t("Email")} value={email} onChange={setEmail} type="email" disabled={busy} required={creating || account.email !== ''} autoFocus={!creating}/>
      <CommunitySelect label={t('Group')} value={groupId} onChange={setGroupId} disabled={busy || (!creating && account.admin)} options={groups.filter(group => !creating && account.admin ? group.kind === 'admin' : group.kind === 'ordinary').map(group => ({ id: group.id, label: communityGroupLabel(group, t) }))}/>
      {creating ? <CommunityField label={t("Temporary password")} value={password} onChange={setPassword} type="password" autoComplete="new-password" disabled={busy} required/> : <section className="drawer-space"><a href={`/admin/usage-records?username=${encodeURIComponent(account.username)}`}>{t("View usage records")}</a><h3>{t("User space")}</h3><dl className="account-details"><dt>{t("Space ID")}</dt><dd className="space-id">{account.spaceId}</dd><dt>{t("Instance status")}</dt><dd><span className={`instance-state state-${account.instance.state}`}><span aria-hidden="true"/>{t(account.instance.state)}</span></dd></dl></section>}
    </form>
    {!creating && <CommunityMemberInstanceResources resources={resources} disabled={busy} onReload={() => guard.request(resources.reload)}/>}
  </CommunityDialog>{guard.dialog}</>;
}
