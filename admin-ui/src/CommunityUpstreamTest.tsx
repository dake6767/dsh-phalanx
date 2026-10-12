import { useState, type ReactNode } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityPluginUpstreamTestResult } from '../../src/domain/admin-contract';
import { testCommunityPluginUpstream } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityMessage from './CommunityMessage';
export default function CommunityUpstreamTest({ packageName, name, ready, actions }: { packageName: string; name: string; ready: boolean; actions?: ReactNode }) {
  const { t, errorText } = usePlatformLanguage();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CommunityPluginUpstreamTestResult>();
  const [error, setError] = useState<unknown>();
  const run = async () => {
    setBusy(true); setError(undefined); setResult(undefined);
    try { setResult(await testCommunityPluginUpstream(packageName, name)); } catch (error) { setError(error); } finally { setBusy(false); }
  };
  return <div className="plugin-upstream-test"><div className="plugin-upstream-actions">{actions}<Button variant="secondary" isDisabled={busy || !ready} onPress={() => { void run(); }}>{t(busy ? 'Testing upstream…' : 'Test saved request')}</Button></div>
    {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {result ? <div className="plugin-upstream-result"><CommunityMessage role="status" status={result.passed ? 'success' : 'warning'} title={t(result.passed ? 'Upstream test passed' : 'Upstream test failed')}/>
      <p>{t('HTTP {status} · {elapsed} ms', { status: result.status, elapsed: result.elapsedMs })}</p>
      <pre className="whitespace-pre-wrap break-all text-xs">{result.body}</pre>{result.truncated ? <p>{t('Response truncated to 4 KiB.')}</p> : null}</div> : null}
  </div>;
}
