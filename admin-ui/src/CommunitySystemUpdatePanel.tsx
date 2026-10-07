import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@heroui/react/button';
import { Chip } from '@heroui/react/chip';
import { Disclosure } from '@heroui/react/disclosure';
import { ProgressBar } from '@heroui/react/progress-bar';
import CommunityDialog from './CommunityDialog';
import type { CommunitySystemUpdateEvent, CommunitySystemUpdateAction, CommunitySystemUpdateCheck, CommunitySystemUpdateOperation, CommunitySystemUpdateStatus } from '../../src/domain/admin-contract';
import { CommunityApiRequestError, communitySystemUpdate, executeCommunitySystemUpdate } from './community-api';
import CommunityMessage from './CommunityMessage';

const operationKey = 'dsh-phalanx-system-update';
const active = new Set(['preparing', 'stopping', 'backing-up', 'backed-up', 'switching', 'validating', 'committed', 'restoring', 'restoration-committed']);
const phases: Record<CommunitySystemUpdateOperation['phase'], string> = {
  preparing: 'Downloading and verifying the update…', prepared: 'Downloaded and verified; ready to apply.',
  'prepare-failed': 'Download or verification failed. Check for updates and retry.', stopping: 'Stopping the service and all user instances…',
  'backing-up': 'Backing up platform state…', 'backed-up': 'Platform backup verified.', switching: 'Switching to the verified target…',
  validating: 'Checking the new service…', committed: 'Update verified; reopening the service…', succeeded: 'Update completed successfully.',
  restoring: 'Update failed; restoring the previous version…', 'restoration-committed': 'Previous version verified; reopening the service…',
  restored: 'Update failed; the previous version was restored.', 'apply-failed': 'Update could not be applied. View the failure before retrying.',
  'recovery-failed': 'Recovery failed. An operator must use the current installer for recovery.',
};
function readOperation(): string | undefined {
  try { const value = localStorage.getItem(operationKey); return value && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value) ? value : undefined; } catch { return undefined; }
}
function storeOperation(id?: string) { try { if (id) localStorage.setItem(operationKey, id); else localStorage.removeItem(operationKey); } catch { /* Status still follows the root owner's latest operation. */ } }

function ApplyDialog({ operation, disabled, onCancel, onConfirm }: { operation: CommunitySystemUpdateOperation; disabled: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <CommunityDialog title={`Apply update: ${operation.targetVersion}`} busy={disabled} onClose={onCancel}
    footer={<><Button variant="tertiary" onPress={onCancel}>Cancel</Button><Button variant="danger" isDisabled={disabled} onPress={onConfirm}>Confirm and apply now</Button></>}>
    <p>The service will be temporarily unavailable. All user instances will restart, all running tasks will be interrupted, and unsaved work may be lost. Confirming starts the update immediately.</p>
  </CommunityDialog>;
}

function UpdateDisclosure({ title, defaultExpanded = false, children }: { title: string; defaultExpanded?: boolean; children: ReactNode }) {
  return <Disclosure className="update-disclosure" defaultExpanded={defaultExpanded}>
    <Disclosure.Heading><Button slot="trigger" variant="ghost" size="sm">{title}<Disclosure.Indicator/></Button></Disclosure.Heading>
    <Disclosure.Content><Disclosure.Body>{children}</Disclosure.Body></Disclosure.Content>
  </Disclosure>;
}

function ProgressFacts({ events, reconnecting }: { events: readonly CommunitySystemUpdateEvent[]; reconnecting: boolean }) {
  let event: CommunitySystemUpdateEvent | undefined;
  for (let index = events.length - 1; index >= 0; index--) { const item = events[index]!; if (item.status !== 'detail' && item.action) { event = item; break; } }
  if (!event) return null;
  const knownTotal = event.total !== undefined && event.total > 0 && event.bytes !== undefined && event.bytes <= event.total;
  const percent = knownTotal ? Math.round(event.bytes! / event.total! * 100) : undefined;
  return <div className="update-progress">
    <p className="muted">{reconnecting ? 'Last reported progress' : event.phase}</p>
    <p className="update-action">{event.action}</p>
    {percent !== undefined ? <><ProgressBar aria-label="Download progress" value={percent} size="sm"><ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar><p>{percent}% · {event.bytes!.toLocaleString()} / {event.total!.toLocaleString()} bytes</p></> : event.bytes !== undefined ? <p>{event.bytes.toLocaleString()} bytes received</p> : null}
    {(event.phaseElapsed !== undefined || event.elapsed !== undefined) && <p className="muted">{[event.phaseElapsed !== undefined && `Phase elapsed: ${Math.round(event.phaseElapsed)}s`, event.elapsed !== undefined && `Total elapsed: ${Math.round(event.elapsed)}s`].filter(Boolean).join(' · ')}</p>}
  </div>;
}

export default function CommunitySystemUpdatePanel() {
  const [snapshot, setSnapshot] = useState<CommunitySystemUpdateStatus>();
  const [check, setCheck] = useState<CommunitySystemUpdateCheck>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string>();
  const [transportError, setTransportError] = useState<string>();
  const [statusError, setStatusError] = useState<{ status: number; message: string }>();
  const operationId = useRef(readOperation());
  const mounted = useRef(false);
  const generation = useRef(0);
  const submitting = useRef(false);
  const remember = (operation: CommunitySystemUpdateOperation | null) => {
    const id = operation && (active.has(operation.phase) || operation.phase === 'prepared') ? operation.id : undefined;
    operationId.current = id; storeOperation(id);
  };
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const observedGeneration = generation.current;
      try {
        const value = await communitySystemUpdate(operationId.current, controller.signal);
        if (controller.signal.aborted) return;
        if (!submitting.current && observedGeneration === generation.current) { remember(value.operation); setSnapshot(value); setReconnecting(false); setTransportError(undefined); setStatusError(undefined); }
      } catch (failure) {
        if (!controller.signal.aborted && !submitting.current && observedGeneration === generation.current) {
          if (failure instanceof CommunityApiRequestError && failure.status !== 503) {
            setReconnecting(false); setStatusError({ status: failure.status, message: failure.message }); setSnapshot(undefined); setCheck(undefined); setConfirm(false);
          } else setReconnecting(true);
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 2000);
    };
    void poll();
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer); };
  }, []);
  const submit = async (input: CommunitySystemUpdateAction) => {
    if (submitting.current || reconnecting || statusError) return;
    submitting.current = true; generation.current++;
    setBusy(true); setError(undefined); setTransportError(undefined);
    if (input.action === 'apply') { operationId.current = input.operation; storeOperation(input.operation); setConfirm(false); setReconnecting(true); }
    try {
      const value = await executeCommunitySystemUpdate(input);
      if (!mounted.current) return;
      if ('check' in value) { setCheck(value.check); setSnapshot(value); remember(value.operation); }
      else { remember(value.operation); setSnapshot(previous => ({ currentVersion: previous?.currentVersion ?? null, runningVersion: previous?.runningVersion ?? null, events: [], operation: value.operation })); }
    } catch (failure) {
      if (!mounted.current) return;
      if (input.action === 'check') setCheck({ status: 'failed', checkedAt: new Date().toISOString(), reason: 'Unable to check the release source' });
      if (input.action !== 'check') setReconnecting(failure instanceof TypeError || failure instanceof CommunityApiRequestError && failure.status === 503);
      const message = failure instanceof Error ? failure.message : 'System update request failed';
      if (failure instanceof TypeError || (failure instanceof CommunityApiRequestError && failure.status === 503)) setTransportError(message);
      else setError(message);
    } finally { submitting.current = false; generation.current++; if (mounted.current) setBusy(false); }
  };
  const operation = snapshot?.operation;
  const changing = operation && active.has(operation.phase);
  return <section id="system-update" className="panel system-update" aria-label="System update">
    <div className="panel-heading"><h2>System update</h2><Button variant="secondary" isDisabled={busy || reconnecting || Boolean(statusError) || Boolean(changing)} onPress={() => { void submit({ action: 'check' }); }}>Check for updates</Button></div>
    <div className="update-versions"><p>Installed version: {snapshot?.currentVersion ?? 'Unknown'}</p><p>Running version: {reconnecting ? 'Unknown while reconnecting.' : snapshot?.runningVersion ?? 'Unknown'}</p></div>
    {reconnecting && snapshot?.runningVersion && <p>Last verified running version: {snapshot.runningVersion}</p>}
    <p>Check manually for compatible formal releases. Downloading leaves the current service running.</p>
    {check && <div aria-live="polite">
      <p>{check.status === 'available' ? `Formal update available: ${check.version}` : check.status === 'current' ? 'No newer formal release was found.' : check.status === 'incompatible' ? `Formal release ${check.version} is incompatible: ${check.reason ?? 'Use the documented installer path.'}` : `Update availability unknown: ${check.reason}`}</p>
      <p>Checked: {check.checkedAt}</p>
      {'releaseNotes' in check && <UpdateDisclosure title="Release notes" defaultExpanded><pre className="update-notes">{check.releaseNotes || 'No release notes supplied.'}</pre></UpdateDisclosure>}
      {check.status === 'available' && <Button isDisabled={busy || reconnecting || Boolean(statusError) || Boolean(changing)} onPress={() => { void submit({ action: 'prepare', version: check.version, manifestSha256: check.manifestSha256 }); }}>Download update</Button>}
    </div>}
    {reconnecting && <p role="status">Reconnecting to the original update. Refreshing or closing this page does not cancel an accepted update.</p>}
    {reconnecting && <p>The update result is unknown until the service responds. If it remains unavailable, follow the <a href="https://github.com/dake6767/dsh-phalanx/blob/main/docs/install.md#recoverable-system-updates" target="_blank" rel="noreferrer">server recovery instructions</a>.</p>}
    {transportError && <CommunityMessage role="alert" status="danger" title={transportError}/>}
    {statusError && <CommunityMessage role="alert" status="danger" title={statusError.message}>{statusError.status === 403 && <a href="/">Return to DSH</a>}{statusError.status === 404 && <Button size="sm" variant="secondary" onPress={() => { operationId.current = undefined; storeOperation(); setStatusError(undefined); }}>Stop following unavailable operation</Button>}</CommunityMessage>}
    {error && <CommunityMessage role="alert" status="danger" title={error}/>}
    {operation && <div aria-live="polite"><div className="update-stage"><Chip size="sm" variant="soft" color={operation.phase === 'succeeded' ? 'success' : /failed/u.test(operation.phase) ? 'danger' : operation.phase === 'restored' ? 'warning' : 'accent'}>{operation.phase}</Chip><h3>Latest operation: {operation.targetVersion}</h3><p>{phases[operation.phase]}</p></div>
      <ProgressFacts events={snapshot?.events ?? []} reconnecting={reconnecting}/>
      {operation.failure && <CommunityMessage status="danger" title={`Update failure: ${operation.failure}`}/>}{operation.stopFailure && <CommunityMessage status="danger" title={`Stop failure: ${operation.stopFailure}`}/>}
      {operation.recoveryFailure && <CommunityMessage status="danger" title={`Recovery failure: ${operation.recoveryFailure}`}/>}{operation.instruction && <CommunityMessage status="warning" title={operation.instruction}/>}
      {operation.phase === 'prepared' && <Button isDisabled={busy || reconnecting || Boolean(statusError)} onPress={() => setConfirm(true)}>Apply update</Button>}
      <UpdateDisclosure title="Update diagnostics"><p>Operation: {operation.id}</p><ol>{snapshot?.events.map((event, index) => <li key={index}>{event.phase}: {event.status} · {event.action ?? event.message} · {event.message}{event.bytes !== undefined && ` (${event.bytes}${event.total === undefined ? '' : ` / ${event.total}`} bytes)`}</li>)}</ol></UpdateDisclosure>
    </div>}
    {confirm && operation?.phase === 'prepared' && <ApplyDialog operation={operation} disabled={busy || reconnecting || Boolean(statusError)} onCancel={() => setConfirm(false)} onConfirm={() => { void submit({ action: 'apply', operation: operation.id, confirmed: true }); }}/>}
  </section>;
}
