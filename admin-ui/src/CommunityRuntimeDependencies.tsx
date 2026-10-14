import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { Chip } from '@heroui/react/chip';
import { Tabs } from '@heroui/react/tabs';
import type { CommunityRuntimeDependencyView } from '../../src/domain/admin-contract';
import type { PlatformMessageKey } from '../../src/domain/platform-copy';
import { communityRuntimeDependencies, changeRuntimeDependency } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityIcon from './CommunityIcon';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';
import CommunitySelect from './CommunitySelect';
import CommunityRuntimeDependencyForm, { DependencyCommandField } from './CommunityRuntimeDependencyForm';

const stages = { preparing: 'Preparing dependency', validating: 'Validating dependency', ready: 'Ready', failed: 'Preparation failed' } as const;
const sources = { manual: 'Manual', 'mcp-catalog': 'MCP catalog', 'migration-0.1.10': '0.1.10 migration' } as const;
const checks = { paths: 'PATH directories', links: 'Symbolic links', commands: 'Command names', 'check-command': 'Check command' } as const;
const failures = { 'prepare-failed': 'Preparation failed', 'path-invalid': 'PATH validation failed', 'link-escape': 'Artifact link validation failed', 'command-conflict': 'Command names conflict', 'check-failed': 'Check command failed', interrupted: 'Preparation interrupted' } as const;
function size(bytes: number): string { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`; }
export default function CommunityRuntimeDependencies() {
  const { t, errorText } = usePlatformLanguage();
  const [items, setItems] = useState<readonly CommunityRuntimeDependencyView[]>(), [filter, setFilter] = useState('all'), [selected, setSelected] = useState<string>(), [tab, setTab] = useState('preparation');
  const [creating, setCreating] = useState(false), [editing, setEditing] = useState(false), [removing, setRemoving] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [revision, setRevision] = useState(0);
  const pending = useRef(false), refresh = () => setRevision(value => value + 1);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try { const rows = await communityRuntimeDependencies(controller.signal); if (controller.signal.aborted) return; setItems(rows); setError(undefined); if (rows.some(row => row.stage === 'preparing' || row.stage === 'validating')) timer = setTimeout(() => { void load(); }, 1000); }
      catch (failure) { if (!controller.signal.aborted) setError(failure); }
    };
    void load(); return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [revision]);
  const detail = items?.find(row => row.name === selected), visible = items?.filter(row => filter === 'all' || row.stage === filter) ?? [];
  const change = async (action: 'prepare' | 'remove') => {
    if (!detail || pending.current) return; pending.current = true; setBusy(true); setError(undefined);
    try { setItems(await changeRuntimeDependency({ action, name: detail.name })); if (action === 'remove') { setSelected(undefined); setRemoving(false); } refresh(); }
    catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  };
  const stage = (row: CommunityRuntimeDependencyView) => t(stages[row.stage]);
  const stageColor = (row: CommunityRuntimeDependencyView) => row.stage === 'failed' ? 'danger' : row.stage === 'ready' ? 'success' : 'warning';
  return <div className="community-page">
    <section className="page-heading plugin-page-heading"><div><h1>{t('Runtime dependencies')}</h1><p>{t('Prepare shared commands for skills, platform execution and MCP services.')}</p></div><Button className="primary-action" onPress={() => setCreating(true)}><CommunityIcon name="plus" size={16}/>{t('Create runtime dependency')}</Button></section>
    {error !== undefined ? <><CommunityMessage role="alert" status="danger" title={errorText(error)}/><Button variant="secondary" onPress={refresh}>{t('Reload dependencies')}</Button></> : null}
    <section className="panel plugin-library-panel" aria-label={t('All runtime dependencies')}>
      <div className="panel-top panel-filter-header"><div><div className="panel-title-row"><h2>{t('All runtime dependencies')}</h2><span className="panel-item-count">{t('{count} dependencies', { count: items ? visible.length : '—' })}</span></div><p>{t('Review preparation, storage and resource references.')}</p></div>
        <CommunitySelect className="panel-filter" hideLabel label={t('Filter by preparation status')} value={filter} onChange={setFilter} options={[{ id: 'all', label: t('All runtime dependencies') }, ...Object.entries(stages).map(([id, label]) => ({ id, label: t(label) }))]}/></div>
      {items === undefined ? <p className="table-empty" role="status">{t('Loading…')}</p> : visible.length === 0 ? <Card className="plugin-library-empty" variant="transparent"><Card.Header><Card.Title>{t(items.length ? 'No dependencies match this filter.' : 'No runtime dependencies yet')}</Card.Title><Card.Description>{t('Create a dependency from a preparation command to get started.')}</Card.Description></Card.Header></Card> : <div className="plugin-card-grid">{visible.map(row => <Card key={row.name} className="plugin-library-card">
        <Card.Header><div className="plugin-card-top"><span className="plugin-card-icon" aria-hidden="true"><CommunityIcon name="plugins" size={20}/></span><Chip size="sm" variant="soft" color={stageColor(row)}>{stage(row)}</Chip></div><Card.Title>{row.name}</Card.Title></Card.Header>
        <Card.Content><dl className="plugin-card-metadata"><div><dt>{t('Source')}</dt><dd>{t(sources[row.source])}</dd></div><div><dt>{t('Storage')}</dt><dd>{row.current ? size(row.current.bytes) : '—'}</dd></div><div><dt>{t('References')}</dt><dd>{row.references.length}</dd></div></dl>{!row.isolated ? <p className="plugin-card-error">{t('Not isolated · development only')}</p> : null}{row.stage === 'failed' && row.current ? <p>{t('Previous usable version remains available.')}</p> : null}</Card.Content>
        <Card.Footer><span className="plugin-details-label" aria-hidden="true">{t('Dependency details')}<CommunityIcon name="chevron" size={14}/></span><Button variant="tertiary" size="sm" aria-label={t('View dependency {name}', { name: row.name })} className="plugin-details-action" onPress={() => { setTab('preparation'); setSelected(row.name); }}/></Card.Footer>
      </Card>)}</div>}
    </section>
    {creating || (editing && detail) ? <CommunityRuntimeDependencyForm {...(editing && detail ? { dependency: detail } : {})} onClose={() => { setCreating(false); setEditing(false); }} onCreated={name => { setCreating(false); setEditing(false); setSelected(name); setTab('preparation'); refresh(); }}/> : null}
    {detail ? <CommunityDialog drawer drawerClassName="plugin-drawer" eyebrow={t('Dependency details')} title={detail.name} closeLabel={t('Close dependency details')} busy={busy} onClose={() => setSelected(undefined)}>
      <div className="drawer-identity plugin-identity"><span className="plugin-card-icon" aria-hidden="true"><CommunityIcon name="plugins" size={22}/></span><div><strong>{detail.name}</strong><span>{t(sources[detail.source])} · {detail.current ? size(detail.current.bytes) : '—'}</span></div><Chip size="sm" variant="soft" color={stageColor(detail)}><span role="status">{stage(detail)}</span></Chip></div>
      {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
      {!detail.isolated ? <CommunityMessage status="warning" title={t('Not isolated · development only')}/> : null}
      {detail.source === 'mcp-catalog' ? <p>{t('Managed by the MCP catalog. Definition is read-only.')}</p> : null}
      {detail.failureCode ? <CommunityMessage role="alert" status="danger" title={t(failures[detail.failureCode])}/> : null}
      <Tabs className="plugin-detail-tabs" selectedKey={tab} onSelectionChange={key => setTab(String(key))} variant="secondary"><Tabs.ListContainer><Tabs.List aria-label={t('Dependency details')}>
        <Tabs.Tab id="preparation">{t('Preparation and checks')}<Tabs.Indicator/></Tabs.Tab><Tabs.Tab id="definition">{t('Definition and references')}<Tabs.Indicator/></Tabs.Tab>
      </Tabs.List></Tabs.ListContainer><Tabs.Panel id="preparation"><section className="plugin-detail-section page-stack">
        <Button variant="secondary" isDisabled={busy || detail.stage === 'preparing' || detail.stage === 'validating'} onPress={() => { void change('prepare'); }}>{t(detail.stage === 'failed' ? 'Retry preparation' : 'Prepare again')}</Button>
        {detail.checks.length ? <dl className="plugin-card-metadata">{detail.checks.map((check, index) => <div key={index}><dt>{t(checks[check.kind])}</dt><dd>{t(check.passed ? 'Passed' : 'Failed')}{check.detail ? ` · ${check.detail}` : ''}</dd></div>)}</dl> : null}
        <DependencyCommandField label={t('Full preparation and check log')} value={detail.log} readOnly rows={16}/>
      </section></Tabs.Panel><Tabs.Panel id="definition"><section className="plugin-detail-section page-stack">
        {detail.source !== 'mcp-catalog' ? <Button variant="secondary" isDisabled={busy || detail.stage === 'preparing' || detail.stage === 'validating'} onPress={() => setEditing(true)}>{t('Edit runtime dependency')}</Button> : null}
        <DependencyCommandField label={t('Prepare command')} value={detail.prepareCommand} readOnly rows={6}/><DependencyCommandField label={t('PATH directories')} value={detail.pathDirectories.join('\n')} readOnly rows={2}/><DependencyCommandField label={t('Check command')} value={detail.checkCommand ?? ''} readOnly rows={2}/>
        <h2>{t('References')}</h2>{detail.references.length ? <><p>{t('Remove these references before deleting the dependency.')}</p><ul>{detail.references.map(reference => <li key={reference.kind + ':' + reference.name}>{t(({ skill: 'Skill', execution: 'Platform execution', mcp: 'MCP service', plugin: 'Plugin' } as Record<string, PlatformMessageKey>)[reference.kind]!)} · {reference.name}</li>)}</ul></> : <p>{t('No resource references this dependency.')}</p>}
      </section></Tabs.Panel></Tabs>
      <div className="plugin-detail-section">{detail.references.length && tab !== 'definition' ? <p>{t('Remove these references before deleting the dependency.')} {detail.references.map(reference => reference.name).join(', ')}</p> : null}<Button variant="danger" isDisabled={busy || detail.references.length > 0} onPress={() => setRemoving(true)}>{t('Delete dependency')}</Button></div>
    </CommunityDialog> : null}
    {removing && detail ? <CommunityDialog title={t('Delete runtime dependency')} busy={busy} onClose={() => setRemoving(false)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => setRemoving(false)}>{t('Cancel')}</Button><Button variant="danger" isDisabled={busy || detail.references.length > 0} onPress={() => { void change('remove'); }}>{t('Delete dependency')}</Button></>}><p>{t('Delete {name} and its unreferenced prepared files?', { name: detail.name })}</p></CommunityDialog> : null}
  </div>;
}
