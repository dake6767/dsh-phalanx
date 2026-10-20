import { usageReasonLabels } from '../../src/domain/usage-messages';
import { useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Table } from '@heroui/react/table';
import { Tabs } from '@heroui/react/tabs';
import { Chip } from '@heroui/react/chip';
import type { CommunityGroupView, CommunityUsageQuery, CommunityUsageRecords as Records } from '../../src/domain/admin-contract';
import { communityGroups, usageRecords } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityField from './CommunityField';
import CommunitySelect from './CommunitySelect';
import CommunityMessage from './CommunityMessage';
import { communityGroupLabel } from './community-group-label';

export default function CommunityUsageRecords() {
  const { t, errorText, locale } = usePlatformLanguage();
  const [username, setUsername] = useState(() => new URLSearchParams(location.search).get('username') ?? '');
  const [groupId, setGroupId] = useState(''), [capability, setCapability] = useState(''), [operation, setOperation] = useState(''), [outcome, setOutcome] = useState('all');
  const [from, setFrom] = useState(''), [until, setUntil] = useState('');
  const [query, setQuery] = useState<CommunityUsageQuery>({ username }), [revision, setRevision] = useState(0);
  const [data, setData] = useState<Records>(), [groups, setGroups] = useState<readonly CommunityGroupView[]>([]), [error, setError] = useState<unknown>();
  useEffect(() => { const controller = new AbortController(); void communityGroups(controller.signal).then(setGroups).catch(failure => { if (!controller.signal.aborted) setError(failure); }); return () => controller.abort(); }, []);
  useEffect(() => { const controller = new AbortController(); void usageRecords(query, controller.signal).then(value => { if (!controller.signal.aborted) { setData(value); setError(undefined); } }).catch(failure => { if (!controller.signal.aborted) setError(failure); }); return () => controller.abort(); }, [query, revision]);
  const groupLabel = (id: string) => { const group = groups.find(row => row.id === id); return group ? communityGroupLabel(group, t) : id || '—'; };
  const apply = () => {
    const start = from ? Date.parse(from) : undefined, end = until ? Date.parse(until) : undefined;
    if (start !== undefined && !Number.isFinite(start) || end !== undefined && !Number.isFinite(end)) { setError(new Error(t('Enter a valid date and time.'))); return; }
    setQuery({ ...(username.trim() ? { username: username.trim() } : {}), ...(groupId ? { groupId } : {}), ...(capability.trim() ? { capability: capability.trim() } : {}),
      ...(operation.trim() ? { operation: operation.trim() } : {}), ...(outcome === 'all' ? {} : { outcome: outcome as 'succeeded' | 'failed' | 'denied' }), ...(start === undefined ? {} : { from: start }), ...(end === undefined ? {} : { until: end }) });
    setRevision(value => value + 1);
  };
  const capabilityKind = (kind: 'plugin-upstream' | 'mcp' | 'web-tools' | 'execution') => t(kind === 'plugin-upstream' ? 'Plugin upstream' : kind === 'mcp' ? 'MCP service' : kind === 'execution' ? 'Platform execution' : 'Web tools');
  const resultText = (result: 'succeeded' | 'failed' | 'denied') => t(result === 'succeeded' ? 'Usage succeeded' : result === 'failed' ? 'Usage failed' : 'Usage denied');
  return <div className="community-page"><section className="page-heading"><div><h1>{t('Usage records')}</h1><p>{t('Gateway usage records include the first execution argument. Other arguments, request bodies and output are not recorded.')}</p></div><Button className="primary-action" onPress={() => setRevision(value => value + 1)}>{t('Refresh records')}</Button></section>
    <p className="muted">{t('Direct outbound proxy traffic, personal credentials, and member-installed or configured content are not recorded. Self-reports cover platform skills only; local plugin tools and member-container MCP are not covered.')}</p>
    {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <section className="panel" aria-label={t('Usage filters')}><form className="usage-filters" onSubmit={event => { event.preventDefault(); apply(); }}>
      <CommunityField label={t('Filter by member')} value={username} onChange={setUsername} variant="secondary"/>
      <CommunitySelect label={t('Filter by group')} value={groupId || 'all'} onChange={value => setGroupId(value === 'all' ? '' : value)} variant="secondary" options={[{ id: 'all', label: t('All groups') }, ...groups.map(group => ({ id: group.id, label: communityGroupLabel(group, t) })), ...(data?.summaries.groups.filter(row => row.key && !groups.some(group => group.id === row.key)).map(row => ({ id: row.key, label: row.key })) ?? [])]}/>
      <CommunityField label={t('Filter by capability')} description={t('For execution, enter skill:<name>.')} value={capability} onChange={setCapability} variant="secondary"/>
      <CommunityField label={t('Filter by operation')} description={t('For execution, enter the command.')} value={operation} onChange={setOperation} variant="secondary"/>
      <CommunitySelect label={t('Filter by result')} value={outcome} onChange={setOutcome} variant="secondary" options={[{ id: 'all', label: t('All results') }, ...(['succeeded', 'failed', 'denied'] as const).map(id => ({ id, label: resultText(id) }))]}/>
      <CommunityField label={t('From (local time)')} value={from} onChange={setFrom} description={t('Date and time, for example 2026-01-01T00:00')} variant="secondary"/>
      <CommunityField label={t('Until (exclusive, local time)')} value={until} onChange={setUntil} description={t('Date and time, for example 2026-01-01T00:00')} variant="secondary"/>
      <Button type="submit" variant="secondary">{t('Apply filters')}</Button>
    </form></section>
    {data && <section className="usage-summaries" aria-label={t('Usage summary')}>{([
      ['members', 'By member'], ['groups', 'By group'], ['capabilities', 'By capability'], ['days', 'By day (UTC)'],
    ] as const).map(([key, label]) => <section className="panel" key={key}><h2>{t(label)}</h2><dl>{data.summaries[key].map(row => <div key={row.key}><dt>{key === 'groups' ? groupLabel(row.key) : row.capability ? `${capabilityKind(row.capability.kind)} · ${row.capability.id} / ${row.capability.operation}` : row.key || '—'}</dt><dd>{row.count.toLocaleString(locale)}</dd></div>)}</dl>{!data.summaries[key].length && <p>{t('No usage records match these filters.')}</p>}</section>)}</section>}
    <Tabs selectedKey="tools"><Tabs.ListContainer><Tabs.List aria-label={t('Usage categories')}><Tabs.Tab id="tools">{t('Tool usage')}<Tabs.Indicator/></Tabs.Tab></Tabs.List></Tabs.ListContainer><Tabs.Panel id="tools">
      <section className="panel">{!data ? <p role="status" className="table-empty">{t('Loading…')}</p> : <><Table variant="secondary"><Table.ScrollContainer><Table.Content aria-label={t('Tool usage records')} className="accounts-table"><Table.Header>
        <Table.Column isRowHeader>{t('Member')}</Table.Column><Table.Column>{t('Group at start')}</Table.Column><Table.Column>{t('Capability type')}</Table.Column><Table.Column>{t('Capability')}</Table.Column><Table.Column>{t('Operation')}</Table.Column><Table.Column>{t('First argument')}</Table.Column><Table.Column>{t('Started')}</Table.Column><Table.Column>{t('Result')}</Table.Column><Table.Column>{t('Duration')}</Table.Column><Table.Column>{t('Exit code')}</Table.Column><Table.Column>{t('Failure reason')}</Table.Column>
      </Table.Header><Table.Body renderEmptyState={() => <p className="table-empty">{t('No usage records match these filters.')}</p>}>{data.items.map(row => <Table.Row key={row.id} id={row.id}><Table.Cell>{row.username}</Table.Cell><Table.Cell>{groupLabel(row.groupId ?? '')}</Table.Cell><Table.Cell>{capabilityKind(row.capability.kind)}</Table.Cell><Table.Cell><code>{row.capability.id}</code></Table.Cell><Table.Cell>{row.capability.operation}</Table.Cell><Table.Cell>{row.capability.firstArgument ?? '—'}</Table.Cell><Table.Cell>{new Date(row.startedAt).toLocaleString(locale)}</Table.Cell><Table.Cell><Chip size="sm" variant="soft" color={row.outcome === 'succeeded' ? 'success' : 'warning'}>{resultText(row.outcome)}</Chip> {row.httpStatus ?? '—'}{row.isError === true ? ` · ${t('Tool error')}` : ''}</Table.Cell><Table.Cell>{row.durationMs.toLocaleString(locale)} ms</Table.Cell><Table.Cell>{row.exitCode ?? '—'}</Table.Cell><Table.Cell>{row.reason ? t(usageReasonLabels[row.reason]) : '—'}</Table.Cell></Table.Row>)}</Table.Body></Table.Content></Table.ScrollContainer></Table>
        <div className="panel-footer"><span>{t('{count} usage records', { count: data.total })}</span><Button size="sm" variant="tertiary" isDisabled={data.page <= 1} onPress={() => setQuery(current => ({ ...current, page: data.page - 1 }))}>{t('Previous page')}</Button><span>{data.page} / {data.pageCount}</span><Button size="sm" variant="tertiary" isDisabled={data.page >= data.pageCount} onPress={() => setQuery(current => ({ ...current, page: data.page + 1 }))}>{t('Next page')}</Button></div></>}
      </section>
    </Tabs.Panel></Tabs>
  </div>;
}
