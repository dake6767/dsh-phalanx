import { useEffect, useRef, useState } from 'react';
import type { CommunityInstanceResourceMember } from '../../src/domain/admin-contract';
import { applyInstanceResources, instanceResourceMember, saveInstanceResourceMember } from './community-api';
import { draftResourceLimits, resourceDraft, resourceDraftChanged } from './CommunityInstanceResourceFields';

/** The account drawer combines this draft with its contact/group draft under one guard. */
export function useMemberInstanceResources(username: string | undefined, onChanged?: () => void) {
  const [saved, setSaved] = useState<CommunityInstanceResourceMember>(), [mode, setMode] = useState<'default' | 'custom'>('default');
  const [resident, setResident] = useState(false);
  const [draft, setDraft] = useState(resourceDraft({ cpus: null, memoryMiB: null, pids: null }));
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [reload, setReload] = useState(0);
  const [selection, setSelection] = useState<CommunityInstanceResourceMember>(), [applyError, setApplyError] = useState<unknown>(), [partial, setPartial] = useState(false);
  const submitting = useRef(false);
  const reset = (value: CommunityInstanceResourceMember) => { setSaved(value); setResident(value.resident); setMode(value.source); setDraft(resourceDraft(value.override ?? value.defaults)); };
  useEffect(() => {
    if (!username) return;
    const controller = new AbortController();
    void instanceResourceMember(username, controller.signal).then(value => { if (!controller.signal.aborted) { reset(value); setError(undefined); } }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [username, reload]);
  const dirty = !!saved && (resident !== saved.resident || mode !== saved.source || mode === 'custom' && resourceDraftChanged(draft, saved.override ?? saved.defaults));
  const save = async () => {
    if (!dirty) return true;
    if (!saved || submitting.current) return false;
    submitting.current = true; setBusy(true); setError(undefined);
    try { reset(await saveInstanceResourceMember({ action: 'save-member', resident, revision: saved.revision, username: saved.username, spaceId: saved.spaceId, override: mode === 'custom' ? draftResourceLimits(draft) : null })); onChanged?.(); return true; }
    catch (failure) { setError(failure); return false; } finally { submitting.current = false; setBusy(false); }
  };
  const apply = async () => {
    if (!selection?.instanceKey || submitting.current) return;
    submitting.current = true; setBusy(true); setApplyError(undefined); setPartial(false);
    try {
      const result = await applyInstanceResources({ action: 'apply', revision: selection.revision, confirmed: true, targets: [{ username: selection.username, spaceId: selection.spaceId, instanceKey: selection.instanceKey }] });
      setSelection(undefined); reset(await instanceResourceMember(selection.username)); setPartial(result.results.some(row => row.status !== 'applied')); onChanged?.();
    } catch (failure) { setApplyError(failure); } finally { submitting.current = false; setBusy(false); }
  };
  return { saved, resident, setResident, mode, setMode, draft, setDraft, dirty, busy, error, save, selection, setSelection, applyError, apply, partial,
    discard: () => { if (saved) reset(saved); }, reload: () => setReload(value => value + 1) };
}
