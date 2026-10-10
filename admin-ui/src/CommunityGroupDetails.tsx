import CommunitySkillSynchronization from './CommunitySkillSynchronization';
import { Tabs } from '@heroui/react/tabs';
import CommunityGroupSkills from './CommunityGroupSkills';
import type { CommunitySkillGroupView } from '../../src/domain/admin-contract';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Checkbox } from '@heroui/react/checkbox';
import type { CommunityManagedGroupView } from '../../src/domain/admin-contract';
import { communityGroupPlugins, updateCommunityGroupPlugins, communityGroupSkills, saveCommunityGroupSkills } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import { communityGroupLabel } from './community-group-label';
import { platformError } from '../../src/domain/platform-copy';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';
import { useDraftGuard } from './useDraftGuard';

export default function CommunityGroupDetails({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const { t, errorText, locale } = usePlatformLanguage();
  const [tab, setTab] = useState('plugins');
  const [skillData, setSkillData] = useState<CommunitySkillGroupView>();
  const [skillSelected, setSkillSelected] = useState<readonly string[]>([]);
  const [confirmSkills, setConfirmSkills] = useState(false);
  const confirmation = useRef<((saved: boolean) => void) | undefined>(undefined);
  const applySkills = (next: CommunitySkillGroupView) => { setSkillData(next); setSkillSelected(next.skills.filter(skill => skill.granted).map(skill => skill.name).sort()); };
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
    void communityGroupSkills(groupId, controller.signal).then(value => { if (!controller.signal.aborted) applySkills(value); }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => { controller.abort(); confirmation.current?.(false); };
  }, [groupId]);
  const pluginDirty = data !== undefined && JSON.stringify([...selected].sort()) !== JSON.stringify(data.plugins.filter(plugin => plugin.granted).map(plugin => plugin.packageName).sort());
  const execute = async (restart: boolean) => {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError(undefined);
    try { apply(await updateCommunityGroupPlugins(groupId, restart ? { action: 'restart', confirmed: true } : { action: 'save', packages: selected })); setConfirmRestart(false); return true; }
    catch (failure) { setError(failure); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  const skillDirty = skillData !== undefined && JSON.stringify([...skillSelected].sort()) !== JSON.stringify(skillData.skills.filter(skill => skill.granted).map(skill => skill.name).sort());
  const dirty = tab === 'skills' ? skillDirty : pluginDirty;
  const requestSkillSave = () => new Promise<boolean>(resolve => { if (confirmation.current || !skillData) { resolve(false); return; } confirmation.current = resolve; setConfirmSkills(true); });
  const finishSkillConfirmation = (saved: boolean) => { setConfirmSkills(false); confirmation.current?.(saved); confirmation.current = undefined; };
  const executeSkills = async () => {
    if (!skillData || pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { applySkills(await saveCommunityGroupSkills(groupId, skillSelected, skillData.revision)); finishSkillConfirmation(true); }
    catch (failure) { setError(failure); finishSkillConfirmation(false); try { applySkills(await communityGroupSkills(groupId)); } catch { /* Keep the original mutation failure visible. */ } }
    finally { pending.current = false; setBusy(false); }
  };
  const save = () => tab === 'skills' ? requestSkillSave() : execute(false);
  const guard = useDraftGuard(dirty, save, () => { if (data) apply(data); if (skillData) applySkills(skillData); }, busy);
  return <><CommunityDialog drawer title={data ? communityGroupLabel(data.group, t) : t('Group details')} eyebrow={t('Group details')} closeLabel={t('Close group details')} busy={busy} onClose={() => guard.request(onClose)}
    footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(onClose)}>{t('Close group details')}</Button>{data?.group.kind === 'ordinary' ? <Button isDisabled={busy || !dirty} onPress={() => { void save(); }}>{busy ? t('Saving…') : t('Save grants')}</Button> : null}</>}>
    <CommunitySkillSynchronization/>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <Tabs className="plugin-detail-tabs" variant="secondary" selectedKey={tab} onSelectionChange={key => guard.request(() => setTab(String(key)))}><Tabs.ListContainer><Tabs.List aria-label={t('Group details')}><Tabs.Tab id="plugins">{t('Plugins')}<Tabs.Indicator/></Tabs.Tab><Tabs.Tab id="skills">{t('Skills')}<Tabs.Indicator/></Tabs.Tab></Tabs.List></Tabs.ListContainer><Tabs.Panel id="plugins">
    {data ? <section className="group-grants" aria-label={t('Plugin grants')}>
      <div className="group-grants-intro"><h3>{t('Plugin grants')}</h3><p>{t('Grant changes take effect the next time each member restarts their instance.')}</p>
      {data.group.kind === 'admin' ? <p>{t('All library plugins are granted automatically to administrators.')}</p> : null}</div>
      <div className="group-grants-status"><p role="status">{t('{count} running members have pending changes.', { count: data.pendingMembers.length })}</p>
      <Button variant="secondary" isDisabled={busy || dirty || data.pendingMembers.length === 0} onPress={() => setConfirmRestart(true)}>{t('Restart affected members')}</Button></div>
      <div className="group-grants-list">{data.plugins.length ? data.plugins.map(plugin => <div className="group-grant-item" key={plugin.packageName}>
        <Checkbox isSelected={selected.includes(plugin.packageName)} isDisabled={busy || data.group.kind === 'admin' || (!plugin.available && !plugin.granted)}
          onChange={checked => setSelected(current => checked ? [...current, plugin.packageName] : current.filter(name => name !== plugin.packageName))}>
          <Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{plugin.title}</Checkbox.Content>
        </Checkbox>
        {plugin.incompatible ? <p role="status">{t('Incompatible with the current version')}</p> : null}
        <p className="text-sm text-muted">{plugin.packageName} · {plugin.version ?? t('Precheck failed')}</p>
        {plugin.failures.map(failure => <CommunityMessage key={failure.username} status="danger" title={`${failure.username}: ${platformError(locale, { code: failure.code, error: '' })}`}/>)}
      </div>) : <p>{t('No plugins yet')}</p>}</div>
    </section> : <p role="status">{t('Loading…')}</p>}
    </Tabs.Panel><Tabs.Panel id="skills"><CommunityGroupSkills data={skillData} selected={skillSelected} onSelect={setSkillSelected} busy={busy}/></Tabs.Panel></Tabs>
  </CommunityDialog>
    {confirmRestart ? <CommunityDialog title={t('Restart affected members')} busy={busy} onClose={() => setConfirmRestart(false)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => setConfirmRestart(false)}>{t('Cancel')}</Button><Button variant="danger" isDisabled={busy} onPress={() => { void execute(true); }}>{t('Confirm action')}</Button></>}><p>{t('Running tasks for affected members will be interrupted. Stopped instances will not be started.')}</p></CommunityDialog> : null}
    {confirmSkills && skillData ? <CommunityDialog title={t('Confirm skill grants')} busy={busy} onClose={() => finishSkillConfirmation(false)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => finishSkillConfirmation(false)}>{t('Cancel')}</Button><Button isDisabled={busy} onPress={() => { void executeSkills(); }}>{t('Confirm action')}</Button></>}><p>{t('{count} affected members', { count: skillData.members })}</p><CommunityMessage status="warning" title={t('Changes apply to new sessions. Running tasks using this skill may fail.')}/></CommunityDialog> : null}
    {guard.dialog}
  </>;
}
