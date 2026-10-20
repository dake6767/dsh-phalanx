import { useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Table } from '@heroui/react/table';
import type { CommunityGroupView, CommunityModelSettings, CommunityModelUsage, CommunityModelUsageQuery } from '../../src/domain/admin-contract';
import { communityGroups, communityModels, modelUsage } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityField from './CommunityField';
import CommunitySelect from './CommunitySelect';
import CommunityMessage from './CommunityMessage';
import { communityGroupLabel } from './community-group-label';

function utcDays(days: number) {
  const now = new Date(), end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return { from: end - days * 86400000, until: end };
}
function hourText(value: number) { return new Date(value).toISOString().slice(0, 16); }
function hourValue(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00$/u.test(value)) return;
  const time = Date.parse(value + 'Z');
  return Number.isSafeInteger(time) && time >= 0 && hourText(time) === value ? time : undefined;
}

export default function CommunityUsageModels({ revision }: { revision: number }) {
  const { t, errorText, locale } = usePlatformLanguage();
  const [username, setUsername] = useState(() => new URLSearchParams(location.search).get('username') ?? '');
  const [groupId, setGroupId] = useState(''), [modelId, setModelId] = useState('');
  const [from, setFrom] = useState(() => hourText(utcDays(1).from)), [until, setUntil] = useState(() => hourText(utcDays(1).until));
  const [query, setQuery] = useState<CommunityModelUsageQuery>(() => ({ ...utcDays(1), ...(username ? { username } : {}) }));
  const [data, setData] = useState<CommunityModelUsage>(), [models, setModels] = useState<CommunityModelSettings>(), [groups, setGroups] = useState<readonly CommunityGroupView[]>([]), [error, setError] = useState<unknown>();
  useEffect(() => { const controller = new AbortController(); void Promise.all([communityModels(controller.signal), communityGroups(controller.signal)]).then(([models, groups]) => { if (!controller.signal.aborted) { setModels(models); setGroups(groups); } }).catch(failure => { if (!controller.signal.aborted) setError(failure); }); return () => controller.abort(); }, []);
  useEffect(() => { const controller = new AbortController(); void modelUsage(query, controller.signal).then(value => { if (!controller.signal.aborted) { setData(value); setError(undefined); } }).catch(failure => { if (!controller.signal.aborted) setError(failure); }); return () => controller.abort(); }, [query, revision]);
  const labels = new Map(models?.providers.flatMap(provider => provider.models.map(model => [model.id, `${provider.name} / ${model.name}`] as const)) ?? []);
  const groupLabel = (id: string) => { const group = groups.find(row => row.id === id); return group ? communityGroupLabel(group, t) : id || '—'; };
  const filters = () => ({ ...(username.trim() ? { username: username.trim() } : {}), ...(groupId ? { groupId } : {}), ...(modelId ? { modelId } : {}) });
  const apply = () => {
    const start = hourValue(from), end = hourValue(until);
    if (start === undefined || end === undefined || start >= end) { setError(new Error(t('Choose a valid UTC hour range.'))); return; }
    setQuery({ ...filters(), from: start, until: end });
  };
  const preset = (days: number) => { const range = utcDays(days); setFrom(hourText(range.from)); setUntil(hourText(range.until)); setQuery({ ...filters(), ...range }); };
  return <>
    <p className="muted">{t('Known token totals are shown separately from unknown requests. Missing counters remain unknown. All ranges use UTC hours, based on when each request started.')}</p>
    {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <section className="panel" aria-label={t('Model usage filters')}><form className="usage-filters" onSubmit={event => { event.preventDefault(); apply(); }}>
      <CommunityField label={t('Filter by member')} value={username} onChange={setUsername} variant="secondary"/>
      <CommunitySelect label={t('Filter by group')} value={groupId || 'all'} onChange={value => setGroupId(value === 'all' ? '' : value)} variant="secondary" options={[{ id: 'all', label: t('All groups') }, ...groups.map(group => ({ id: group.id, label: communityGroupLabel(group, t) })), ...(data?.summaries.groups.filter(row => row.key && !groups.some(group => group.id === row.key)).map(row => ({ id: row.key, label: row.key })) ?? [])]}/>
      <CommunitySelect label={t('Filter by model')} value={modelId || 'all'} onChange={value => setModelId(value === 'all' ? '' : value)} variant="secondary" options={[{ id: 'all', label: t('All models') }, ...[...labels].map(([id, label]) => ({ id, label })), ...[...new Set(data?.items.map(row => row.modelId) ?? [])].filter(id => !labels.has(id)).map(id => ({ id, label: id }))]}/>
      <CommunityField label={t('From (UTC hour)')} value={from} onChange={setFrom} description={t('For example 2026-01-01T00:00. Hours only.')} variant="secondary"/>
      <CommunityField label={t('Until (exclusive, UTC hour)')} value={until} onChange={setUntil} description={t('For example 2026-01-01T00:00. Hours only.')} variant="secondary"/>
      <Button type="submit" variant="secondary">{t('Apply filters')}</Button><Button variant="secondary" onPress={() => preset(1)}>{t('Today (UTC)')}</Button><Button variant="secondary" onPress={() => preset(7)}>{t('Last 7 days (UTC)')}</Button>
    </form></section>
    {data && <section className="usage-summaries" aria-label={t('Model usage summary')}>{([['members', 'By member'], ['groups', 'By group'], ['capabilities', 'By model'], ['days', 'By day (UTC)']] as const).map(([key, label]) => <section className="panel" key={key}><h2>{t(label)}</h2><dl>{data.summaries[key].map(row => <div key={row.key}><dt>{key === 'groups' ? groupLabel(row.key) : key === 'capabilities' ? labels.get(row.key) ?? row.key : row.key || '—'}</dt><dd>{row.count.toLocaleString(locale)}</dd></div>)}</dl>{!data.summaries[key].length && <p>{t('No model usage matches these filters.')}</p>}</section>)}</section>}
    <section className="panel">{!data ? <p role="status">{t('Loading…')}</p> : <Table variant="secondary"><Table.ScrollContainer><Table.Content aria-label={t('Model token totals')} className="accounts-table"><Table.Header>
      <Table.Column isRowHeader>{t('Member')}</Table.Column><Table.Column>{t('Shared model')}</Table.Column><Table.Column>{t('Requests')}</Table.Column><Table.Column>{t('Input tokens')}</Table.Column><Table.Column>{t('Output tokens')}</Table.Column><Table.Column>{t('Cache read tokens')}</Table.Column><Table.Column>{t('Cache write tokens')}</Table.Column><Table.Column>{t('Unknown requests')}</Table.Column><Table.Column>{t('Denied requests')}</Table.Column>
    </Table.Header><Table.Body renderEmptyState={() => <p className="table-empty">{t('No model usage matches these filters.')}</p>}>{data.items.map(row => <Table.Row key={JSON.stringify([row.username, row.modelId])} id={JSON.stringify([row.username, row.modelId])}><Table.Cell>{row.username}</Table.Cell><Table.Cell>{labels.get(row.modelId) ?? row.modelId}</Table.Cell><Table.Cell>{row.requests.toLocaleString(locale)}</Table.Cell>{[row.tokens.input, row.tokens.output, row.tokens.cacheRead, row.tokens.cacheWrite].map((value, index) => <Table.Cell key={index}>{value === null ? '—' : value.toLocaleString(locale)}</Table.Cell>)}<Table.Cell>{row.unknownRequests.toLocaleString(locale)}</Table.Cell><Table.Cell>{row.deniedRequests.toLocaleString(locale)}</Table.Cell></Table.Row>)}</Table.Body></Table.Content></Table.ScrollContainer></Table>}</section>
  </>;
}
