import { useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunitySkillDetail } from '../../src/domain/admin-contract';
import { saveSkillRuntimeDependencies, communitySkillDetail } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import { useDraftGuard } from './useDraftGuard';
import CommunityDependencyPicker from './CommunityDependencyPicker';
import CommunityMessage from './CommunityMessage';
export default function CommunitySkillDependencies({ detail, onChanged, onCloseGuard }: { detail: CommunitySkillDetail; onChanged: () => void; onCloseGuard: (guard: ((action: () => void) => void) | undefined) => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [saved, setSaved] = useState(detail), [names, setNames] = useState([...(detail.runtimeDependencies ?? [])]), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [notice, setNotice] = useState(false);
  const dirty = JSON.stringify([...names].sort()) !== JSON.stringify([...(saved.runtimeDependencies ?? [])].sort());
  const save = async () => {
    if (busy) return false; setBusy(true); setError(undefined); setNotice(false);
    try { await saveSkillRuntimeDependencies({ action: 'runtime-dependencies', name: saved.name, names, revision: saved.revision }); const next = await communitySkillDetail(saved.name); setSaved(next); setNames([...(next.runtimeDependencies ?? [])]); setNotice(true); onChanged(); return true; }
    catch (failure) { setError(failure); return false; } finally { setBusy(false); }
  };
  const guard = useDraftGuard(dirty, save, () => setNames([...(saved.runtimeDependencies ?? [])]), busy);
  useEffect(() => { onCloseGuard(guard.request); return () => onCloseGuard(undefined); }, [onCloseGuard, guard.request]);
  return <section className="plugin-detail-section page-stack"><p>{t('Members who own this skill receive these commands in new calls, without restarting their instance.')}</p>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {notice ? <CommunityMessage role="status" status="success" title={t('Runtime dependency references saved.')}/> : null}
    <CommunityDependencyPicker value={names} onChange={setNames} disabled={busy}/><div><Button isDisabled={busy || !dirty} onPress={() => { void save(); }}>{t('Save changes')}</Button></div>{guard.dialog}
  </section>;
}
