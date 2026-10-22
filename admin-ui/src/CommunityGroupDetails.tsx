import type { CommunityExpertGroup } from '../../src/domain/admin-contract';
import { communityGroupExperts, saveCommunityGroupExperts } from './community-api';
import CommunityGroupMcp from './CommunityGroupMcp';
import { communityGroupMcp, saveCommunityGroupMcp } from './community-api';
import type { CommunityMcpGroup } from '../../src/domain/admin-contract';
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
  const [mcpData, setMcpData] = useState<CommunityMcpGroup>();
  const [mcpSelected, setMcpSelected] = useState<readonly string[]>([]);
  const applyMcp = (next: CommunityMcpGroup) => { setMcpData(next); setMcpSelected(next.services.filter(row => row.granted).map(row => row.name).sort()); };
  const [expertData, setExpertData] = useState<CommunityExpertGroup>();
  const [expertSelected, setExpertSelected] = useState<readonly string[]>([]);
  const applyExperts = (next: CommunityExpertGroup) => { setExpertData(next); setExpertSelected(next.experts.filter(row => row.granted).map(row => row.id).sort()); };
  const [tab, setTab] = useState('plugins');
  const [skillData, setSkillData] = useState<CommunitySkillGroupView>();
  const [skillSelected, setSkillSelected] = useState<readonly string[]>([]);
  const [packSelected, setPackSelected] = useState<readonly string[]>([]);
  const [confirmSkills, setConfirmSkills] = useState(false);
  const confirmation = useRef<((saved: boolean) => void) | undefined>(undefined);
  const applySkills = (next: CommunitySkillGroupView) => { setSkillData(next); setPackSelected(next.packs?.filter(pack => pack.granted).map(pack => pack.name).sort() ?? []); setSkillSelected(next.skills.filter(skill => skill.granted).map(skill => skill.name).sort()); };
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
    void communityGroupExperts(groupId, controller.signal).then(value => { if (!controller.signal.aborted) applyExperts(value); }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    void communityGroupMcp(groupId, controller.signal).then(value => { if (!controller.signal.aborted) applyMcp(value); }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    void communityGroupSkills(groupId, controller.signal).then(value => { if (!controller.signal.aborted) applySkills(value); }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => { controller.abort(); confirmation.current?.(false); };
  }, [groupId]);
  useEffect(() => {
    if (!data?.plugins.some(plugin => plugin.checking?.length) || busy) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void communityGroupPlugins(groupId, controller.signal).then(next => {
        if (!controller.signal.aborted) setData(previous => previous ? { ...previous, plugins: previous.plugins.map(plugin => {
          const current = next.plugins.find(row => row.packageName === plugin.packageName);
          return current ? { ...plugin, checking: current.checking, failures: current.failures } : plugin;
        }) } : previous);
      }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    }, 1000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [data, groupId, busy]);
  const pluginDirty = data !== undefined && JSON.stringify([...selected].sort()) !== JSON.stringify(data.plugins.filter(plugin => plugin.granted).map(plugin => plugin.packageName).sort());
  const execute = async (restart: boolean) => {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError(undefined);
    try { apply(await updateCommunityGroupPlugins(groupId, restart ? { action: 'restart', confirmed: true } : { action: 'save', packages: selected })); setConfirmRestart(false); return true; }
    catch (failure) { setError(failure); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  const packDirty = skillData !== undefined && JSON.stringify([...packSelected].sort()) !== JSON.stringify(skillData.packs?.filter(pack => pack.granted).map(pack => pack.name).sort() ?? []);
  const skillDirty = packDirty || skillData !== undefined && JSON.stringify([...skillSelected].sort()) !== JSON.stringify(skillData.skills.filter(skill => skill.granted).map(skill => skill.name).sort());
  const mcpDirty = mcpData !== undefined && JSON.stringify([...mcpSelected].sort()) !== JSON.stringify(mcpData.services.filter(row => row.granted).map(row => row.name).sort());
  const executeMcp = async () => {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError(undefined);
    try { applyMcp(await saveCommunityGroupMcp(groupId, mcpSelected)); return true; }
    catch (failure) { setError(failure); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  const expertDirty = expertData !== undefined && JSON.stringify([...expertSelected].sort()) !== JSON.stringify(expertData.experts.filter(row => row.granted).map(row => row.id).sort());
  const executeExperts = async () => {
    if (!expertData || pending.current) return false;
    pending.current = true; setBusy(true); setError(undefined);
    try { applyExperts(await saveCommunityGroupExperts(groupId, expertSelected, expertData.revision)); return true; }
    catch (failure) { setError(failure); return false; } finally { pending.current = false; setBusy(false); }
  };
  const dirty = tab === 'experts' ? expertDirty : tab === 'mcp' ? mcpDirty : tab === 'skills' ? skillDirty : pluginDirty;
  const requestSkillSave = () => new Promise<boolean>(resolve => { if (confirmation.current || !skillData) { resolve(false); return; } confirmation.current = resolve; setConfirmSkills(true); });
  const finishSkillConfirmation = (saved: boolean) => { setConfirmSkills(false); confirmation.current?.(saved); confirmation.current = undefined; };
  const executeSkills = async () => {
    if (!skillData || pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { applySkills(await saveCommunityGroupSkills(groupId, skillSelected, skillData.revision, packSelected)); finishSkillConfirmation(true); }
    catch (failure) { setError(failure); finishSkillConfirmation(false); try { applySkills(await communityGroupSkills(groupId)); } catch { /* Keep the original mutation failure visible. */ } }
    finally { pending.current = false; setBusy(false); }
  };
  const save = () => tab === 'experts' ? executeExperts() : tab === 'mcp' ? executeMcp() : tab === 'skills' ? requestSkillSave() : execute(false);
  const guard = useDraftGuard(dirty, save, () => { if (data) apply(data); if (skillData) applySkills(skillData); if (mcpData) applyMcp(mcpData); if (expertData) applyExperts(expertData); }, busy);
  return <><CommunityDialog drawer title={data ? communityGroupLabel(data.group, t) : t('Group details')} eyebrow={t('Group details')} closeLabel={t('Close group details')} busy={busy} onClose={() => guard.request(onClose)}
    footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(onClose)}>{t('Close group details')}</Button>{data ? <Button isDisabled={busy || !dirty} onPress={() => { void save(); }}>{busy ? t('Saving…') : t('Save grants')}</Button> : null}</>}>
    <CommunitySkillSynchronization/>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <Tabs className="plugin-detail-tabs" variant="secondary" selectedKey={tab} onSelectionChange={key => guard.request(() => setTab(String(key)))}><Tabs.ListContainer><Tabs.List aria-label={t('Group details')}><Tabs.Tab id="plugins">{t('Plugins')}<Tabs.Indicator/></Tabs.Tab><Tabs.Tab id="skills">{t('Skills')}<Tabs.Indicator/></Tabs.Tab><Tabs.Tab id="experts">{t('Expert grants')}<Tabs.Indicator/></Tabs.Tab><Tabs.Tab id="mcp">{t('MCP grants')}<Tabs.Indicator/></Tabs.Tab></Tabs.List></Tabs.ListContainer><Tabs.Panel id="plugins">
    {data ? <section className="group-grants" aria-label={t('Plugin grants')}>
      <div className="group-grants-intro"><h3>{t('Plugin grants')}</h3><p>{t('Grant changes take effect the next time each member restarts their instance.')}</p>
      {data.group.kind === 'admin' ? <p>{t('Administrator instances only receive explicitly configured plugins.')}</p> : null}</div>
      <div className="group-grants-status"><p role="status">{t('{count} running members have pending changes.', { count: data.pendingMembers.length })}</p>
      <Button variant="secondary" isDisabled={busy || dirty || data.pendingMembers.length === 0} onPress={() => setConfirmRestart(true)}>{t('Restart affected members')}</Button></div>
      <div className="group-grants-list">{data.plugins.length ? data.plugins.map(plugin => <div className="group-grant-item" key={plugin.packageName}>
        <Checkbox isSelected={selected.includes(plugin.packageName)} isDisabled={busy || (!plugin.available && !plugin.granted)}
          onChange={checked => setSelected(current => checked ? [...current, plugin.packageName] : current.filter(name => name !== plugin.packageName))}>
          <Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{plugin.title}</Checkbox.Content>
        </Checkbox>
        {plugin.incompatible ? <p role="status">{t('Incompatible with the current version')}</p> : null}
        <p className="text-sm text-muted">{plugin.packageName} · {plugin.version ?? t('Precheck failed')}</p>
        {plugin.checking?.length ? <CommunityMessage status="default" title={t('Checking capabilities…')}/> : null}
        {plugin.failures.map(failure => <CommunityMessage key={failure.username} status="danger" title={`${failure.username}: ${platformError(locale, { code: failure.code, error: '' })}`}/>)}
      </div>) : <p>{t('No plugins yet')}</p>}</div>
    </section> : <p role="status">{t('Loading…')}</p>}
    </Tabs.Panel><Tabs.Panel id="skills"><CommunityGroupSkills data={skillData} selected={skillSelected} onSelect={setSkillSelected} busy={busy} packs={packSelected} onPacks={setPackSelected}/></Tabs.Panel><Tabs.Panel id="mcp"><CommunityGroupMcp data={mcpData} selected={mcpSelected} onSelect={setMcpSelected} busy={busy}/></Tabs.Panel><Tabs.Panel id="experts"><section className="group-grants" aria-label={t('Expert grants')}><h3>{t('Expert grants')}</h3><p>{t('Expert changes take effect after members restart their instances.')}</p><CommunityMessage status="warning" title={t('Members granted this expert can use all its entries and platform credentials, including entries not granted separately.')}/><div className="group-grants-list">{expertData?.experts.map(expert => <div className="group-grant-item" key={expert.id}><Checkbox isSelected={expertSelected.includes(expert.id)} isDisabled={busy} onChange={checked => setExpertSelected(current => checked ? [...current, expert.id] : current.filter(id => id !== expert.id))}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{expert.name}</Checkbox.Content></Checkbox><p>{expert.description}</p></div>)}</div>{expertData?.group.kind === 'admin' ? <p>{t('Administrator instances only receive explicitly configured experts.')}</p> : null}</section></Tabs.Panel></Tabs>
  </CommunityDialog>
    {confirmRestart ? <CommunityDialog title={t('Restart affected members')} busy={busy} onClose={() => setConfirmRestart(false)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => setConfirmRestart(false)}>{t('Cancel')}</Button><Button variant="danger" isDisabled={busy} onPress={() => { void execute(true); }}>{t('Confirm action')}</Button></>}><p>{t('Running tasks for affected members will be interrupted. Stopped instances will not be started.')}</p></CommunityDialog> : null}
    {confirmSkills && skillData ? <CommunityDialog title={t('Confirm skill grants')} busy={busy} onClose={() => finishSkillConfirmation(false)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => finishSkillConfirmation(false)}>{t('Cancel')}</Button><Button isDisabled={busy} onPress={() => { void executeSkills(); }}>{t('Confirm action')}</Button></>}><p>{t('{count} affected members', { count: skillData.members })}</p><CommunityMessage status="warning" title={t('Changes apply to new sessions. Running tasks using this skill may fail.')}/></CommunityDialog> : null}
    {guard.dialog}
  </>;
}
