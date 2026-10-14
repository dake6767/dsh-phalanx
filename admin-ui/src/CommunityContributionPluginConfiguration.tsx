import { Button } from '@heroui/react/button';
import { TextField } from '@heroui/react/textfield';
import { TextArea } from '@heroui/react/textarea';
import { Label } from '@heroui/react/label';
import { useState } from 'react';
import type { ContributionPluginDraft, CommunityContributionPluginView, CommunityPluginUpstreamInput, CommunityPluginUpstreamTestResult } from '../../src/domain/admin-contract';
import type { PluginContributionDeclaration } from '../../src/domain/plugin-contribution-checks';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';
import { usePlatformLanguage } from './CommunityLanguage';

export default function CommunityContributionPluginConfiguration({ draft, onChange, declaration, removed, busy, onTest }: {
  draft: ContributionPluginDraft; onChange: (draft: ContributionPluginDraft) => void; declaration?: PluginContributionDeclaration;
  removed: CommunityContributionPluginView['removed']; busy: boolean; onTest: (input: CommunityPluginUpstreamInput) => Promise<CommunityPluginUpstreamTestResult>;
}) {
  const { t, errorText } = usePlatformLanguage();
  const [testing, setTesting] = useState<string>(), [result, setResult] = useState<CommunityPluginUpstreamTestResult>(), [error, setError] = useState<unknown>();
  const update = (index: number, value: Partial<CommunityPluginUpstreamInput>) => onChange({ ...draft, upstreams: draft.upstreams.map((row, i) => i === index ? { ...row, ...value } : row) });
  const credential = (index: number, value: string) => onChange({ ...draft, upstreams: draft.upstreams.map((row, i) => { if (i !== index) return row; const { credential, ...rest } = row; void credential; return value ? { ...rest, credential: value } : rest; }) });
  const test = async (input: CommunityPluginUpstreamInput) => { setTesting(input.name); setError(undefined); setResult(undefined); try { setResult(await onTest(input)); } catch (failure) { setError(failure); } finally { setTesting(undefined); } };
  const removedItems = [...removed.environment, ...removed.entries, ...removed.upstreams];
  return <section className="plugin-detail-section">
    <p>{t('Plugin upstreams and access templates are prefilled. Enter platform credentials; existing credentials remain when left blank.')}</p>
    {removedItems.length ? <CommunityMessage status="warning" title={t('Items removed from the declaration are retained until you choose to clear them.')}>{removedItems.join(', ')}</CommunityMessage> : null}
    {draft.upstreams.map((upstream, index) => <section className="plugin-detail-section" key={upstream.name}>
      <h3>{upstream.name}</h3>
      <CommunityField label={t('Upstream base URL')} value={upstream.baseUrl} type="url" disabled={busy || !!testing} onChange={value => update(index, { baseUrl: value })}/>
      <CommunityField label={t('Platform credential')} value={upstream.credential ?? ''} type="password" autoComplete="new-password" disabled={busy || !!testing} onChange={value => credential(index, value)} description={t(upstream.hasCredential ? 'A credential is configured. Leave blank to retain it.' : 'Only the platform stores this credential.')}/>
      <h4>{t('Request headers')}</h4><pre className="plugin-raw-config">{upstream.headers.map(row => row.name + ': ' + row.value).join('\n') || '—'}</pre>
      {upstream.testRequest ? <><p>{upstream.testRequest.method} {upstream.testRequest.path}</p><Button variant="secondary" isDisabled={busy || !!testing || !upstream.credential && !upstream.hasCredential} onPress={() => { void test(upstream); }}>{t('Test upstream')}</Button></> : null}
    </section>)}
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {result ? <CommunityMessage status={result.passed ? 'success' : 'warning'} title={t('HTTP {status}', { status: result.status })}><pre className="plugin-raw-config">{result.body}</pre></CommunityMessage> : null}
    <h3>{t('Plugin environment variables')}</h3>
    {draft.access.environment.map((row, index) => {
      const variable = declaration?.environment.find(variable => variable.name === row.name);
      return <div className="plugin-environment-row" key={row.name}><CommunityField label={t('Environment name')} value={row.name} readOnly/><CommunityField label={t('Environment value')} value={row.value} readOnly={variable?.secret ?? false} disabled={busy} onChange={value => onChange({ ...draft, access: { ...draft.access, environment: draft.access.environment.map((item, i) => i === index ? { ...item, value } : item) } })} description={variable ? variable.purpose + ' · ' + variable.application : undefined}/></div>;
    })}
    <p>{t('Use {upstream:name} for the forwarding address and {access-token} for the member token. Keep platform credentials in upstream settings.')}</p>
    <TextField value={draft.access.entriesYaml} onChange={value => onChange({ ...draft, access: { ...draft.access, entriesYaml: value } })} isDisabled={busy}><Label>{t('Entry configuration YAML')}</Label><TextArea className="plugin-yaml-input" rows={8}/></TextField>
  </section>;
}
