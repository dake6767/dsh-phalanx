import type { CommunityGroupView } from '../../src/domain/admin-contract';
import CommunitySelect from './CommunitySelect';
import { communityGroupLabel } from './community-group-label';
import { usePlatformLanguage } from './CommunityLanguage';
import { useId, useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityAccountActionRequest, CommunityAccountView } from '../../src/domain/admin-contract';
import CommunityDialog from './CommunityDialog';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';
interface AccountSelection { readonly account: CommunityAccountView; readonly request: Exclude<CommunityAccountActionRequest, { action: 'set-email' }> }
export default function CommunityAccountActionDialog({ selection, groups, busy, error, onCancel, onConfirm }: {
  groups: readonly CommunityGroupView[]; selection: AccountSelection; busy: boolean; error?: unknown; onCancel: () => void; onConfirm: (input: CommunityAccountActionRequest) => Promise<void>;
}) {
  const { t, errorText } = usePlatformLanguage();
  const [groupId, setGroupId] = useState(groups.find(group => group.isDefault)?.id ?? '');
  const [password, setPassword] = useState('');
  const formId = useId();
  const { account, request } = selection;
  const title = request.action === 'reset-password' ? t("Reset password") : request.action === 'delete' ? t("Delete account")
    : request.action === 'set-disabled' ? request.disabled ? t("Disable account") : t("Enable account") : request.admin ? t("Make administrator") : t("Remove administrator role");
  const explanation = request.action === 'delete' ? t("Access will end and the user instance will stop. User-space files will be preserved. A new account with this username will receive a separate user space.")
    : request.action === 'reset-password' ? t("All existing logins will be signed out. The running user instance will be retained.")
    : request.action === 'set-disabled' ? request.disabled ? t("All existing logins will be signed out and the user instance will stop.") : t("The member can sign in again. Previously revoked logins remain invalid.")
    : request.admin ? t("This account will be able to manage all accounts.") : t("This account will lose access to account management.");
  return <CommunityDialog title={t("{action}: {username}", { action: title, username: account.username })} busy={busy} onClose={onCancel}
    footer={<><Button variant="tertiary" type="button" onPress={onCancel} isDisabled={busy}>{t("Cancel")}</Button><Button type="submit" form={formId} variant={request.action === 'delete' ? 'danger' : 'primary'} isDisabled={busy}>{busy ? t("Applying…") : t("Confirm action")}</Button></>}>
    <p>{explanation}</p>{error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <form id={formId} onSubmit={event => { event.preventDefault(); if (!busy) void onConfirm(request.action === 'reset-password' ? { action: request.action, password } : request.action === 'set-admin' && !request.admin ? { ...request, groupId } : request); }}>
      {request.action === 'set-admin' && !request.admin ? <CommunitySelect label={t('Target group')} description={t('Choose an ordinary group for this account after removing its administrator role.')} value={groupId} onChange={setGroupId} disabled={busy} options={groups.filter(group => group.kind === 'ordinary').map(group => ({ id: group.id, label: communityGroupLabel(group, t) }))}/> : null}
      {request.action === 'reset-password' ? <CommunityField label={t("New password")} value={password} onChange={setPassword} type="password" autoComplete="new-password" required disabled={busy} autoFocus/> : null}
    </form>
  </CommunityDialog>;
}
