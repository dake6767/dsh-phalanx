import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Table } from '@heroui/react/table';
import type { CommunityMcpSettings } from '../../src/domain/admin-contract';
import { communityMcp, updateCommunityMcp } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import McpEditor from './CommunityMcpEditor';
import CommunityIcon from './CommunityIcon';
import CommunityMessage from './CommunityMessage';

export default function CommunityMcpPage() {
  const { t, errorText } = usePlatformLanguage();
  const [rows, setRows] = useState<readonly CommunityMcpSettings[]>();
  const [editing, setEditing] = useState<CommunityMcpSettings | 'new'>();
  const [removing, setRemoving] = useState<CommunityMcpSettings>();
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState<'MCP service saved.' | 'MCP service removed.'>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useEffect(() => { const controller = new AbortController(); void communityMcp(controller.signal).then(setRows).catch(failure => { if (!controller.signal.aborted) setError(failure); }); return () => controller.abort(); }, []);
  const remove = async () => {
    if (!removing || pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { setRows(await updateCommunityMcp({ action: 'remove', name: removing.name })); setRemoving(undefined); setNotice('MCP service removed.'); }
    catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="community-page">
    <section className="page-heading"><div><h1>{t('MCP library')}<span className="heading-dot" aria-hidden="true">.</span></h1><p>{t('Manage remote tools and grant them to member groups.')}</p></div><Button className="primary-action" onPress={() => setEditing('new')}><CommunityIcon name="plus" size={16}/>{t('Add MCP service')}</Button></section>
    {error !== undefined && !removing ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {notice ? <CommunityMessage role="status" status="success" title={t(notice)}/> : null}
    <section className="panel group-panel" aria-label={t('MCP services')}>
      <div className="panel-top"><div><div className="panel-title-row"><h2>{t('All MCP services')}</h2><span className="panel-item-count">{rows?.length ?? '—'}</span></div><p>{t('Adding a service does not grant access or publish it.')}</p></div></div>
      {rows === undefined ? <p className="table-empty" role="status">{t('Loading…')}</p> : rows.length === 0 ? <p className="table-empty">{t('No MCP services yet')}</p> : <Table variant="secondary" className="group-table"><Table.ScrollContainer><Table.Content className="accounts-table" aria-label={t('MCP services')}>
        <Table.Header><Table.Column isRowHeader>{t('MCP service name')}</Table.Column><Table.Column>{t('Description')}</Table.Column><Table.Column>{t('Actions')}</Table.Column></Table.Header>
        <Table.Body>{rows.map(row => <Table.Row id={row.name} key={row.name}><Table.Cell><strong>{row.name}</strong></Table.Cell><Table.Cell>{row.description || '—'}</Table.Cell><Table.Cell><div className="account-actions"><Button size="sm" variant="secondary" onPress={() => setEditing(row)}><CommunityIcon name="edit" size={14}/>{t('Edit')}</Button><Button size="sm" variant="tertiary" onPress={() => { setError(undefined); setRemoving(row); }}>{t('Remove')}</Button></div></Table.Cell></Table.Row>)}</Table.Body>
      </Table.Content></Table.ScrollContainer></Table>}
      <div className="panel-footer group-list-note"><CommunityIcon name="shield" size={16}/><span>{t('MCP changes take effect immediately. Tools update on the next agent request.')}</span></div>
    </section>
    {editing ? <McpEditor onRefreshed={next => setRows(rows => rows?.map(row => row.name === next.name ? next : row))} value={editing} onClose={() => setEditing(undefined)} onSaved={next => { setRows(next); setNotice('MCP service saved.'); }}/>: null}
    {removing ? <CommunityDialog title={t('Remove MCP service')} busy={busy} onClose={() => setRemoving(undefined)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => setRemoving(undefined)}>{t('Cancel')}</Button><Button variant="danger" isDisabled={busy} onPress={() => { void remove(); }}>{t('Confirm action')}</Button></>}><p>{t('Remove {name}? Its grants and access will end immediately.', { name: removing.name })}</p>{error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}</CommunityDialog> : null}
  </div>;
}
