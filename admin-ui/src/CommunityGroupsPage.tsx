import CommunityGroupDetails from './CommunityGroupDetails';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Table } from '@heroui/react/table';
import { Chip } from '@heroui/react/chip';
import { Dropdown } from '@heroui/react/dropdown';
import { Label } from '@heroui/react/label';
import CommunityIcon from './CommunityIcon';
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
  return <div className="community-page">
    <section className="page-heading"><div><h1>{t('Group management')}<span className="heading-dot" aria-hidden="true">.</span></h1><p>{t('Manage account groups and the default for new members.')}</p></div><Button className="primary-action" onPress={() => setSelection({ action: 'create' })}><CommunityIcon name="plus" size={16}/>{t('Create group')}</Button></section>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <section className="panel group-panel" aria-label={t('Groups')}>
      <div className="panel-top"><div><div className="panel-title-row"><h2>{t('All groups')}</h2><span className="panel-item-count">{t('{count} groups', { count: groups?.length ?? '—' })}</span></div><p>{t('Manage membership, plugin grants and skill grants for each group.')}</p></div></div>
      {groups === undefined ? <p className="table-empty" role="status">{t('Loading…')}</p> : <Table variant="secondary" className="group-table"><Table.ScrollContainer><Table.Content className="accounts-table groups-table" aria-label={t('Groups')}>
        <Table.Header><Table.Column isRowHeader>{t('Group')}</Table.Column><Table.Column>{t('Role')}</Table.Column><Table.Column>{t('Members')}</Table.Column><Table.Column>{t('Granted plugins')}</Table.Column><Table.Column>{t('Granted skills')}</Table.Column><Table.Column>{t('Actions')}</Table.Column></Table.Header>
        <Table.Body>{groups.map(group => <Table.Row key={group.id} id={group.id}>
          <Table.Cell><div className="group-identity"><span className="avatar group-avatar" aria-hidden="true"><CommunityIcon name={group.kind === 'admin' ? 'shield' : 'groups'} size={18}/></span><div><strong>{communityGroupLabel(group, t)}</strong>{group.isDefault ? <span className="group-default">{t('Default for new accounts')}</span> : null}</div></div></Table.Cell>
          <Table.Cell><Chip size="sm" variant="soft" color={group.kind === 'admin' ? 'success' : 'default'}>{t(group.kind === 'admin' ? 'Administrators' : 'Ordinary group')}</Chip></Table.Cell>
          <Table.Cell><span className="group-count">{group.memberCount}</span></Table.Cell><Table.Cell><span className="group-count">{group.pluginCount ?? 0}</span></Table.Cell><Table.Cell><span className="group-count">{group.skillCount ?? 0}</span></Table.Cell>
          <Table.Cell><div className="account-actions">
            <Button size="sm" variant="secondary" onPress={() => setDetails(group.id)}>{t('Details')}</Button>
            <Button size="sm" variant="tertiary" onPress={() => setSelection({ action: 'rename', group })}><CommunityIcon name="edit" size={14}/>{t('Rename group')}</Button>
            <Dropdown><Button size="sm" variant="ghost" aria-label={t('More actions for group {name}', { name: communityGroupLabel(group, t) })}><CommunityIcon name="more" size={16}/></Button><Dropdown.Popover><Dropdown.Menu aria-label={t('Actions')} onAction={key => {
              if (key === 'default') setSelection({ action: 'set-default', group });
              else if (key === 'delete') setSelection({ action: 'delete', group });
            }}>
              <Dropdown.Item id="default" textValue={t('Set as default')} isDisabled={group.kind === 'admin' || group.isDefault}><Label>{t('Set as default')}</Label></Dropdown.Item>
              <Dropdown.Item id="delete" textValue={t('Delete group')} variant="danger" isDisabled={group.kind === 'admin' || group.isDefault || group.memberCount > 0}><Label>{t('Delete group')}</Label></Dropdown.Item>
            </Dropdown.Menu></Dropdown.Popover></Dropdown>
          </div></Table.Cell>
        </Table.Row>)}</Table.Body>
      </Table.Content></Table.ScrollContainer></Table>}
      <div className="panel-footer group-list-note"><CommunityIcon name="shield" size={16}/><span>{t('Default and administrator groups cannot be deleted. Move all members before deleting another group.')}</span></div>
    </section>
    {details ? <CommunityGroupDetails key={details} groupId={details} onClose={() => { setDetails(undefined); void communityGroups().then(setGroups).catch(setError); }}/> : null}
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
