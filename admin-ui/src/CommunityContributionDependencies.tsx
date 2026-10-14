import { useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Chip } from '@heroui/react/chip';
import type { CommunityContributionDependencies as Dependencies } from '../../src/domain/contribution-contract';
import type { CommunityRuntimeDependencyView } from '../../src/domain/admin-contract';
import { communityRuntimeDependencies } from './community-api';
import CommunityDependencyPicker from './CommunityDependencyPicker';
import CommunityRuntimeDependencyForm from './CommunityRuntimeDependencyForm';
import CommunityMessage from './CommunityMessage';
import { usePlatformLanguage } from './CommunityLanguage';

export default function CommunityContributionDependencies({ declaration, value, onChange, onReady, busy }: { declaration?: Dependencies; value: readonly string[]; onChange: (names: string[]) => void; onReady: (ready: boolean) => void; busy: boolean }) {
  const { t, errorText } = usePlatformLanguage();
  const [rows, setRows] = useState<readonly CommunityRuntimeDependencyView[]>(), [error, setError] = useState<unknown>();
  const [creating, setCreating] = useState<Dependencies['requirements'][number]>(), [pending, setPending] = useState<string>(), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const items = await communityRuntimeDependencies(controller.signal); if (controller.signal.aborted) return; setRows(items); setError(undefined); if (items.some(row => ['preparing', 'validating'].includes(row.stage))) timer = setTimeout(() => { void load(); }, 1000); }
      catch (failure) { if (!controller.signal.aborted) setError(failure); }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [revision]);
  useEffect(() => { if (pending && rows?.some(row => row.name === pending && row.stage === 'ready' && row.current)) { onChange([...new Set([...value, pending])]); setPending(undefined); } }, [rows, pending, value, onChange]);
  const requirements = declaration?.requirements ?? [];
  const matching = (name: string) => rows?.find(row => value.includes(row.name) && row.current?.commands.includes(name));
  const ready = rows !== undefined && value.every(name => rows.some(row => row.name === name && row.current)) && requirements.every(row => matching(row.name));
  useEffect(() => { onReady(ready); }, [ready, onReady]);
  return <section className="plugin-detail-section page-stack"><h3>{t('Required commands')}</h3>
    <p>{t('Matching dependencies are selected automatically. Review installation instructions and prepare missing commands before adoption.')}</p>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {requirements.map(row => { const match = matching(row.name); return <section className="plugin-detail-section" key={row.name}>
      <div className="plugin-card-top"><strong>{row.name}</strong>{row.added ? <Chip size="sm" variant="soft">{t('Added')}</Chip> : null}<Chip size="sm" variant="soft" color={match ? 'success' : 'warning'}>{match ? match.name : t('Missing command')}</Chip></div>
      <p>{row.purpose}</p><pre className="plugin-raw-config">{row.installation}</pre>
      {!match ? <Button variant="secondary" isDisabled={busy || Boolean(pending)} onPress={() => setCreating(row)}>{t('Prepare this command')}</Button> : null}
    </section>; })}
    {declaration?.removed.length ? <p>{t('Removed required commands')}: {declaration.removed.join(', ')} · {t('Existing dependency references are retained until you remove them.')}</p> : null}
    {pending ? <CommunityMessage status="warning" title={t('Waiting for dependency preparation')}>{pending} · {rows?.find(row => row.name === pending)?.stage === 'failed' ? t('Preparation failed. Open runtime dependencies to inspect the log and retry.') : t('The reference will be added when preparation succeeds.')}<Button variant="tertiary" onPress={() => { setPending(undefined); setRevision(number => number + 1); }}>{t('Reload dependencies')}</Button></CommunityMessage> : null}
    <CommunityDependencyPicker value={value} onChange={onChange} disabled={busy} items={rows}/>
    {creating ? <CommunityRuntimeDependencyForm initialInput={{ name: creating.name, prepareCommand: creating.installation, checkCommand: 'command -v ' + creating.name }} onClose={() => setCreating(undefined)} onCreated={name => { setCreating(undefined); setPending(name); setRevision(number => number + 1); }}/> : null}
  </section>;
}
