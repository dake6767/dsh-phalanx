import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Checkbox } from '@heroui/react/checkbox';
import type { CommunityManagedGroupView } from '../../src/domain/admin-contract';
import { communityGroupPlugins, updateCommunityGroupPlugins } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import { communityGroupLabel } from './community-group-label';
import { platformError } from '../../src/domain/platform-copy';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';
import { useDraftGuard } from './useDraftGuard';

export default function CommunityGroupPlugins({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const { t, errorText, locale } = usePlatformLanguage();
  const [data, setData] = useState<CommunityManagedGroupView>();
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const pending = useRef(false);
  const apply = (next: CommunityManagedGroupView) => { setData(next); setSelected(next.plugins.filter(plugin => plugin.granted).map(plugin => plugin.packageName).sort()); };
  useEffect(() => {
    const controller = new AbortController();
    void communityGroupPlugins(groupId, controller.signal).then(value => { if (!controller.signal.aborted) apply(value); }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [groupId]);
  const dirty = data !== undefined && JSON.stringify([...selected].sort()) !== JSON.stringify(data.plugins.filter(plugin => plugin.granted).map(plugin => plugin.packageName).sort());
  const execute = async (restart: boolean) => {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError(undefined);
    try { apply(await updateCommunityGroupPlugins(groupId, restart ? { action: 'restart', confirmed: true } : { action: 'save', packages: selected })); setConfirmRestart(false); return true; }
    catch (failure) { setError(failure); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  const guard = useDraftGuard(dirty, () => execute(false), () => { if (data) apply(data); }, busy);
  return <><CommunityDialog drawer title={data ? communityGroupLabel(data.group, t) : t('Plugin grants')} closeLabel={t('Close group details')} busy={busy} onClose={() => guard.request(onClose)}
    footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(onClose)}>{t('Close group details')}</Button>{data?.group.kind === 'ordinary' ? <Button isDisabled={busy || !dirty} onPress={() => { void execute(false); }}>{busy ? t('Saving…') : t('Save grants')}</Button> : null}</>}>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {data ? <div className="page-stack">
      <p>{t('Grant changes take effect the next time each member restarts their instance.')}</p>
      {data.group.kind === 'admin' ? <p>{t('All library plugins are granted automatically to administrators.')}</p> : null}
      <p role="status">{t('{count} running members have pending changes.', { count: data.pendingMembers.length })}</p>
      <Button variant="secondary" isDisabled={busy || dirty || data.pendingMembers.length === 0} onPress={() => setConfirmRestart(true)}>{t('Restart affected members')}</Button>
      {data.plugins.length ? data.plugins.map(plugin => <div key={plugin.packageName}>
        <Checkbox isSelected={selected.includes(plugin.packageName)} isDisabled={busy || data.group.kind === 'admin' || (!plugin.available && !plugin.granted)}
          onChange={checked => setSelected(current => checked ? [...current, plugin.packageName] : current.filter(name => name !== plugin.packageName))}>
          <Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{plugin.title}</Checkbox.Content>
        </Checkbox>
        {plugin.incompatible ? <p role="status">{t('Incompatible with the current version')}</p> : null}
        <p className="text-sm text-muted">{plugin.packageName} · {plugin.version ?? t('Precheck failed')}</p>
        {plugin.failures.map(failure => <CommunityMessage key={failure.username} status="danger" title={`${failure.username}: ${platformError(locale, { code: failure.code, error: '' })}`}/>)}
      </div>) : <p>{t('No plugins yet')}</p>}
    </div> : <p role="status">{t('Loading…')}</p>}
  </CommunityDialog>
    {confirmRestart ? <CommunityDialog title={t('Restart affected members')} busy={busy} onClose={() => setConfirmRestart(false)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => setConfirmRestart(false)}>{t('Cancel')}</Button><Button variant="danger" isDisabled={busy} onPress={() => { void execute(true); }}>{t('Confirm action')}</Button></>}><p>{t('Running tasks for affected members will be interrupted. Stopped instances will not be started.')}</p></CommunityDialog> : null}
    {guard.dialog}
  </>;
}
