import CommunityGroupPlugins from './CommunityGroupPlugins';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Table } from '@heroui/react/table';
import type { CommunityGroupAction, CommunityGroupView } from '../../src/domain/admin-contract';
import { communityGroups, updateCommunityGroups } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import { communityGroupLabel } from './community-group-label';
import CommunityDialog from './CommunityDialog';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';
import { useDraftGuard } from './useDraftGuard';

type Selection = { action: 'create' } | { action: 'rename' | 'delete' | 'set-default'; group: CommunityGroupView };

export default function CommunityGroupsPage() {
  const { t, errorText } = usePlatformLanguage();
  const [groups, setGroups] = useState<readonly CommunityGroupView[]>();
  const [details, setDetails] = useState<string>();
  const [selection, setSelection] = useState<Selection>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    void communityGroups(controller.signal).then(setGroups).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, []);
  return <div className="page-stack">
    <div className="page-title"><div><h1>{t('Group management')}</h1><p>{t('Manage account groups and the default for new members.')}</p></div><Button onPress={() => setSelection({ action: 'create' })}>{t('Create group')}</Button></div>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <p>{t('Default and administrator groups cannot be deleted. Move all members before deleting another group.')}</p>
    {groups === undefined ? <p role="status">{t('Loading…')}</p> : <Table><Table.ScrollContainer><Table.Content className="min-w-[700px]" aria-label={t('Groups')}>
      <Table.Header><Table.Column isRowHeader>{t('Group')}</Table.Column><Table.Column>{t('Role')}</Table.Column><Table.Column>{t('Members')}</Table.Column><Table.Column>{t('Granted plugins')}</Table.Column><Table.Column>{t('Actions')}</Table.Column></Table.Header>
      <Table.Body>{groups.map(group => <Table.Row key={group.id} id={group.id}>
        <Table.Cell>{communityGroupLabel(group, t)}{group.isDefault ? <p>{t('Default for new accounts')}</p> : null}</Table.Cell>
        <Table.Cell>{t(group.kind === 'admin' ? 'Administrators' : 'Ordinary group')}</Table.Cell>
        <Table.Cell>{group.memberCount}</Table.Cell><Table.Cell>{group.pluginCount ?? 0}</Table.Cell>
        <Table.Cell><div className="account-actions">
          <Button size="sm" variant="secondary" onPress={() => setDetails(group.id)}>{t('Plugin grants')}</Button><Button size="sm" variant="secondary" onPress={() => setSelection({ action: 'rename', group })}>{t('Rename group')}</Button>
          <Button size="sm" variant="tertiary" isDisabled={group.kind === 'admin' || group.isDefault} onPress={() => setSelection({ action: 'set-default', group })}>{t('Set as default')}</Button>
          <Button size="sm" variant="danger" isDisabled={group.kind === 'admin' || group.isDefault || group.memberCount > 0} onPress={() => setSelection({ action: 'delete', group })}>{t('Delete group')}</Button>
        </div></Table.Cell>
      </Table.Row>)}</Table.Body>
    </Table.Content></Table.ScrollContainer></Table>}
    {details ? <CommunityGroupPlugins key={details} groupId={details} onClose={() => { setDetails(undefined); void communityGroups().then(setGroups).catch(setError); }}/> : null}
    {selection ? <GroupDialog selection={selection} onClose={() => setSelection(undefined)} onSaved={items => { setGroups(items); setError(undefined); setSelection(undefined); }}/> : null}
  </div>;
}

function GroupDialog({ selection, onClose, onSaved }: { selection: Selection; onClose: () => void; onSaved: (groups: readonly CommunityGroupView[]) => void }) {
  const { t, errorText } = usePlatformLanguage();
  const initial = selection.action === 'create' ? '' : communityGroupLabel(selection.group, t);
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submitting = useRef(false);
  const formId = useId();
  const editable = selection.action === 'create' || selection.action === 'rename';
  const save = async () => {
    if (submitting.current || (editable && !name.trim()) || (selection.action === 'rename' && name === initial)) return false;
    submitting.current = true; setBusy(true); setError(undefined);
    try {
      const input: CommunityGroupAction = selection.action === 'create' ? { action: 'create', name }
        : selection.action === 'rename' ? { action: 'rename', id: selection.group.id, name }
        : selection.action === 'delete' ? { action: 'delete', id: selection.group.id }
        : { action: 'set-default', id: selection.group.id, confirmed: true };
      onSaved(await updateCommunityGroups(input)); return true;
    } catch (failure) { setError(failure); return false; }
    finally { submitting.current = false; setBusy(false); }
  };
  const guard = useDraftGuard(editable && name !== initial, save, () => setName(initial), busy);
  return <><CommunityDialog title={t(selection.action === 'create' ? 'Create group' : selection.action === 'rename' ? 'Rename group' : selection.action === 'delete' ? 'Delete group' : 'Set as default')} busy={busy} onClose={() => guard.request(onClose)}
    footer={<><Button variant="tertiary" onPress={() => guard.request(onClose)} isDisabled={busy}>{t('Cancel')}</Button><Button type="submit" form={formId} variant={selection.action === 'delete' ? 'danger' : 'primary'} isDisabled={busy || (editable && !name.trim()) || (selection.action === 'rename' && name === initial)}>{busy ? t('Saving…') : t('Confirm action')}</Button></>}>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <form id={formId} onSubmit={event => { event.preventDefault(); void save(); }}>
      {editable ? <CommunityField label={t('Group name')} value={name} onChange={setName} required disabled={busy} autoFocus/> : <p>{t(selection.action === 'delete' ? 'Delete the empty group {name}?' : 'Set {name} as the default for new accounts?', { name: initial })}</p>}
      {selection.action === 'set-default' ? <p>{t('The new default applies only to accounts created afterward.')}</p> : null}
    </form>
  </CommunityDialog>{guard.dialog}</>;
}
