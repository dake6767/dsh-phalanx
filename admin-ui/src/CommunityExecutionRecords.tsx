import { useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Table } from '@heroui/react/table';
import { Chip } from '@heroui/react/chip';
import type { CommunityExecutionRecord as ExecutionRecord } from '../../src/domain/admin-contract';
import { executionRecords } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';
import CommunityIcon from './CommunityIcon';

export default function CommunityExecutionRecords() {
  const { t, errorText, locale } = usePlatformLanguage();
  const [rows, setRows] = useState<readonly ExecutionRecord[]>(), [username, setUsername] = useState(''), [skill, setSkill] = useState('');
  const [query, setQuery] = useState({ username: '', owner: '', revision: 0 }), [error, setError] = useState<unknown>(), [page, setPage] = useState(0);
  useEffect(() => { const controller = new AbortController(); void executionRecords(query.username, query.owner, controller.signal).then(value => { if (!controller.signal.aborted) { setRows(value); setPage(0); setError(undefined); } }).catch(failure => { if (!controller.signal.aborted) setError(failure); }); return () => controller.abort(); }, [query]);
  const reload = () => setQuery(current => ({ username: username.trim(), owner: skill.trim() ? 'skill:' + skill.trim() : '', revision: current.revision + 1 }));
  const visible = rows?.slice(page * 50, (page + 1) * 50) ?? [];
  return <div className="community-page"><section className="page-heading"><div><h1>{t('Platform execution records')}<span className="heading-dot" aria-hidden="true">.</span></h1><p>{t('Read-only records from the last 30 days. Arguments and output are never recorded.')}</p></div><Button className="primary-action" onPress={reload}>{t('Refresh records')}</Button></section>
    {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <section className="panel" aria-label={t('Platform execution records')}><div className="panel-top"><form className="plugin-environment-row" onSubmit={event => { event.preventDefault(); reload(); }}><CommunityField label={t('Filter by member')} value={username} onChange={setUsername}/><CommunityField label={t('Filter by skill')} value={skill} onChange={setSkill}/><Button type="submit" variant="secondary">{t('Apply filters')}</Button></form></div>
      {!rows ? <p className="table-empty" role="status">{t('Loading…')}</p> : <Table variant="secondary" className="group-table"><Table.ScrollContainer><Table.Content className="accounts-table" aria-label={t('Execution history')}><Table.Header>
        <Table.Column isRowHeader>{t('Member')}</Table.Column><Table.Column>{t('Skill')}</Table.Column><Table.Column>{t('Command')}</Table.Column><Table.Column>{t('Started')}</Table.Column><Table.Column>{t('Duration')}</Table.Column><Table.Column>{t('Result')}</Table.Column>
      </Table.Header><Table.Body renderEmptyState={() => <p className="table-empty">{t('No execution records match these filters.')}</p>}>{visible.map((row, index) => <Table.Row key={`${row.startedAt}-${index}`} id={`${row.startedAt}-${index}`}><Table.Cell><strong>{row.username}</strong></Table.Cell><Table.Cell>{row.owner.replace(/^skill:/, '')}</Table.Cell><Table.Cell><code>{row.command}</code></Table.Cell><Table.Cell>{new Date(row.startedAt).toLocaleString(locale)}</Table.Cell><Table.Cell>{row.durationMs} ms</Table.Cell><Table.Cell><Chip size="sm" variant="soft" color={row.reason || row.exitCode ? 'warning' : 'success'}>{row.reason ?? t('Exit code: {code}', { code: row.exitCode ?? '—' })}</Chip></Table.Cell></Table.Row>)}</Table.Body></Table.Content></Table.ScrollContainer></Table>}
      <div className="panel-footer"><CommunityIcon name="shield" size={16}/><span>{t('30-day retention')}</span><Button size="sm" variant="tertiary" isDisabled={!page} onPress={() => setPage(value => value - 1)}>{t('Previous page')}</Button><Button size="sm" variant="tertiary" isDisabled={!rows || (page + 1) * 50 >= rows.length} onPress={() => setPage(value => value + 1)}>{t('Next page')}</Button></div>
    </section></div>;
}
