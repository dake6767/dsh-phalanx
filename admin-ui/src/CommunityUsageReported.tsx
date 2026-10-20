import CommunitySelect from './CommunitySelect';
import { communityGroupLabel } from './community-group-label';
import { useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Table } from '@heroui/react/table';
import type { CommunityReportedUsage, CommunityReportedUsageQuery, CommunityGroupView } from '../../src/domain/admin-contract';
import { communityGroups, reportedUsage } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';

function dayValue(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isSafeInteger(time) && time >= 0 && new Date(time).toISOString().slice(0, 10) === value ? time : undefined;
}
function recentDays() { const now = new Date(), until = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1); return { from: until - 7 * 86400000, until }; }
const dayText = (day: number) => new Date(day).toISOString().slice(0, 10);

export default function CommunityUsageReported({ revision }: { revision: number }) {
  const { t, errorText, locale } = usePlatformLanguage();
  const [username, setUsername] = useState(() => new URLSearchParams(location.search).get('username') ?? ''), [skill, setSkill] = useState('');
  const [from, setFrom] = useState(() => dayText(recentDays().from)), [until, setUntil] = useState(() => dayText(recentDays().until));
  const [query, setQuery] = useState<CommunityReportedUsageQuery>(() => ({ ...recentDays(), ...(username ? { username } : {}) }));
  const [groupId, setGroupId] = useState(''), [groups, setGroups] = useState<readonly CommunityGroupView[]>([]);
  const [data, setData] = useState<CommunityReportedUsage>(), [error, setError] = useState<unknown>();
  useEffect(() => { const controller = new AbortController(); void communityGroups(controller.signal).then(value => { if (!controller.signal.aborted) setGroups(value); }).catch(failure => { if (!controller.signal.aborted) setError(failure); }); return () => controller.abort(); }, []);
  const groupLabel = (id: string) => { const group = groups.find(row => row.id === id); return group ? communityGroupLabel(group, t) : id || '—'; };
  useEffect(() => { const controller = new AbortController(); void reportedUsage(query, controller.signal).then(value => { if (!controller.signal.aborted) { setData(value); setError(undefined); } }).catch(failure => { if (!controller.signal.aborted) setError(failure); }); return () => controller.abort(); }, [query, revision]);
  const apply = () => {
    const start = dayValue(from), end = dayValue(until);
    if (start === undefined || end === undefined || start >= end) { setError(new Error(t('Choose a valid UTC day range.'))); return; }
    setQuery({ from: start, until: end, ...(groupId ? { groupId } : {}), ...(username.trim() ? { username: username.trim() } : {}), ...(skill.trim() ? { skill: skill.trim() } : {}) });
  };
  return <>
    <p>{t('Reported by member instances. The platform cannot verify these counts.')}</p>
    <p className="muted">{t('Plugin-local tools and member-container MCP are excluded. Plugin upstreams and remote or shared MCP retain gateway records.')}</p>
    {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <section className="panel"><form className="usage-filters" onSubmit={event => { event.preventDefault(); apply(); }}>
      <CommunityField label={t('Filter by member')} value={username} onChange={setUsername} variant="secondary"/>
      <CommunitySelect label={t('Filter by group')} value={groupId || 'all'} onChange={value => setGroupId(value === 'all' ? '' : value)} variant="secondary" options={[{ id: 'all', label: t('All groups') }, ...groups.map(group => ({ id: group.id, label: communityGroupLabel(group, t) })), ...(data?.summaries.groups.filter(row => row.key && !groups.some(group => group.id === row.key)).map(row => ({ id: row.key, label: row.key })) ?? [])]}/>
      <CommunityField label={t('Filter by skill')} value={skill} onChange={setSkill} variant="secondary"/>
      <CommunityField label={t('From (UTC day)')} value={from} onChange={setFrom} variant="secondary"/>
      <CommunityField label={t('Until (exclusive, UTC day)')} value={until} onChange={setUntil} variant="secondary"/>
      <Button type="submit" variant="secondary">{t('Apply filters')}</Button>
    </form></section>
    {data && <section className="usage-summaries" aria-label={t('Self-reported usage summary')}>{([['members', 'By member'], ['groups', 'By group'], ['capabilities', 'By skill'], ['days', 'By day (UTC)']] as const).map(([key, label]) => <section className="panel" key={key}><h2>{t(label)}</h2><dl>{data.summaries[key].map(row => <div key={row.key}><dt>{key === 'groups' ? groupLabel(row.key) : row.key || '—'}</dt><dd>{row.count.toLocaleString(locale)}</dd></div>)}</dl>{!data.summaries[key].length && <p>{t('No self-reported usage matches these filters.')}</p>}</section>)}</section>}
    <section className="panel">{!data ? <p role="status">{t('Loading…')}</p> : <Table variant="secondary"><Table.ScrollContainer><Table.Content aria-label={t('Self-reported skill loads')} className="accounts-table"><Table.Header>
      <Table.Column isRowHeader>{t('Member')}</Table.Column><Table.Column>{t('Skill')}</Table.Column><Table.Column>{t('Day (UTC)')}</Table.Column><Table.Column>{t('Reported loads')}</Table.Column>
    </Table.Header><Table.Body renderEmptyState={() => <p className="table-empty">{t('No self-reported usage matches these filters.')}</p>}>{data.items.map(row => <Table.Row key={JSON.stringify([row.username, row.skill, row.day])} id={JSON.stringify([row.username, row.skill, row.day])}><Table.Cell>{row.username}</Table.Cell><Table.Cell>{row.skill}</Table.Cell><Table.Cell>{dayText(row.day)}</Table.Cell><Table.Cell>{row.count.toLocaleString(locale)}</Table.Cell></Table.Row>)}</Table.Body></Table.Content></Table.ScrollContainer></Table>}</section>
  </>;
}
