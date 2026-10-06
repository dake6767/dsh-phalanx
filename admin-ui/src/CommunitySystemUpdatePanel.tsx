import { useEffect, useRef, useState } from 'react';
import type { CommunitySystemUpdateAction, CommunitySystemUpdateCheck, CommunitySystemUpdateOperation, CommunitySystemUpdateStatus } from '../../src/domain/admin-contract';
import { CommunityApiRequestError, communitySystemUpdate, executeCommunitySystemUpdate } from './community-api';

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
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="account-dialog" aria-labelledby="apply-update-title" onCancel={event => { event.preventDefault(); onCancel(); }}>
    <h2 id="apply-update-title">Apply update: {operation.targetVersion}</h2>
    <p>The service will be temporarily unavailable. All user instances will restart, all running tasks will be interrupted, and unsaved work may be lost. Confirming starts the update immediately.</p>
    <div className="dialog-actions"><button className="secondary" onClick={onCancel}>Cancel</button><button className="danger" disabled={disabled} onClick={onConfirm}>Confirm and apply now</button></div>
  </dialog>;
}

export default function CommunitySystemUpdatePanel() {
  const [snapshot, setSnapshot] = useState<CommunitySystemUpdateStatus>();
  const [check, setCheck] = useState<CommunitySystemUpdateCheck>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string>();
  const [transportError, setTransportError] = useState<string>();
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
      try {
        const observedGeneration = generation.current;
        const value = await communitySystemUpdate(operationId.current, controller.signal);
        if (controller.signal.aborted) return;
        if (!submitting.current && observedGeneration === generation.current) { remember(value.operation); setSnapshot(value); setReconnecting(false); setTransportError(undefined); }
      } catch { if (!controller.signal.aborted) setReconnecting(true); }
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 2000);
    };
    void poll();
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer); };
  }, []);
  const submit = async (input: CommunitySystemUpdateAction) => {
    if (submitting.current || reconnecting) return;
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
      if (input.action !== 'check') setReconnecting(true);
      const message = failure instanceof Error ? failure.message : 'System update request failed';
      if (failure instanceof TypeError || (failure instanceof CommunityApiRequestError && failure.status === 503)) setTransportError(message);
      else setError(message);
    } finally { submitting.current = false; generation.current++; if (mounted.current) setBusy(false); }
  };
  const operation = snapshot?.operation;
  const changing = operation && active.has(operation.phase);
  return <section id="system-update" className="panel system-update" aria-label="System update">
    <div className="panel-heading"><h2>System update</h2><button className="secondary" disabled={busy || reconnecting || Boolean(changing)} onClick={() => { void submit({ action: 'check' }); }}>Check for updates</button></div>
    <p>Installed version: {snapshot?.currentVersion ?? 'Unknown'}</p><p>Running version: {reconnecting ? 'Unknown while reconnecting.' : snapshot?.runningVersion ?? 'Unknown'}</p>
    {reconnecting && snapshot?.runningVersion && <p>Last verified running version: {snapshot.runningVersion}</p>}
    <p>Check manually for compatible formal releases. Downloading leaves the current service running.</p>
    {check && <div aria-live="polite">
      <p>{check.status === 'available' ? `Formal update available: ${check.version}` : check.status === 'current' ? 'No newer formal release was found.' : check.status === 'incompatible' ? `Formal release ${check.version} is incompatible: ${check.reason ?? 'Use the documented installer path.'}` : `Update availability unknown: ${check.reason}`}</p>
      <p>Checked: {check.checkedAt}</p>
      {'releaseNotes' in check && <details open><summary>Release notes</summary><pre className="update-notes">{check.releaseNotes || 'No release notes supplied.'}</pre></details>}
      {check.status === 'available' && <button disabled={busy || reconnecting || Boolean(changing)} onClick={() => { void submit({ action: 'prepare', version: check.version, manifestSha256: check.manifestSha256 }); }}>Download update</button>}
    </div>}
    {reconnecting && <p role="status">Reconnecting to the original update. Refreshing or closing this page does not cancel an accepted update.</p>}
    {reconnecting && <p>The update result is unknown until the service responds. If it remains unavailable, follow the <a href="https://github.com/dake6767/dsh-phalanx/blob/main/docs/install.md#recoverable-system-updates" target="_blank" rel="noreferrer">server recovery instructions</a>.</p>}
    {transportError && <p role="alert" className="message error">{transportError}</p>}
    {error && <p role="alert" className="message error">{error}</p>}
    {operation && <div aria-live="polite"><h3>Latest operation: {operation.targetVersion}</h3><p>{phases[operation.phase]}</p>
      {operation.failure && <p>Update failure: {operation.failure}</p>}{operation.stopFailure && <p>Stop failure: {operation.stopFailure}</p>}
      {operation.recoveryFailure && <p>Recovery failure: {operation.recoveryFailure}</p>}{operation.instruction && <p>{operation.instruction}</p>}
      {operation.phase === 'prepared' && <button disabled={busy || reconnecting} onClick={() => setConfirm(true)}>Apply update</button>}
      <details><summary>Update diagnostics</summary><p>Operation: {operation.id}</p><ol>{snapshot?.events.map((event, index) => <li key={index}>{event.phase}: {event.message}{event.bytes !== undefined && ` (${event.bytes}${event.total === undefined ? '' : ` / ${event.total}`} bytes)`}</li>)}</ol></details>
    </div>}
    {confirm && operation?.phase === 'prepared' && <ApplyDialog operation={operation} disabled={busy || reconnecting} onCancel={() => setConfirm(false)} onConfirm={() => { void submit({ action: 'apply', operation: operation.id, confirmed: true }); }}/>}
  </section>;
}
