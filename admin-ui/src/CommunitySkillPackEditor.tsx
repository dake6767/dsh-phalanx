import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Checkbox } from '@heroui/react/checkbox';
import { TextField } from '@heroui/react/textfield';
import { TextArea } from '@heroui/react/textarea';
import { Label } from '@heroui/react/label';
import type { CommunitySkillPackInput, CommunitySkillPackDetail, CommunitySkillView } from '../../src/domain/admin-contract';
import { communitySkillPacks, communitySkillPackDetail, communitySkills, saveCommunitySkillPack, removeCommunitySkillPack } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import { useDraftGuard } from './useDraftGuard';
import CommunityDialog from './CommunityDialog';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';

const blank: CommunitySkillPackInput = { name: '', description: '', skills: [], instructions: '', published: false };
const input = (row: CommunitySkillPackInput): CommunitySkillPackInput => ({ name: row.name, description: row.description, skills: row.skills, instructions: row.instructions, published: row.published });
export default function CommunitySkillPackEditor({ name, onClose, onSaved }: { name: string; onClose: () => void; onSaved: () => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [draft, setDraft] = useState<CommunitySkillPackInput>(blank), [saved, setSaved] = useState<CommunitySkillPackInput>(blank);
  const [skills, setSkills] = useState<readonly CommunitySkillView[]>(), [revision, setRevision] = useState(''), [detail, setDetail] = useState<CommunitySkillPackDetail>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [removing, setRemoving] = useState(false), [deleteSkills, setDeleteSkills] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([communitySkills(controller.signal), name ? communitySkillPackDetail(name, controller.signal) : communitySkillPacks(controller.signal)]).then(([rows, value]) => {
      if (controller.signal.aborted) return;
      setSkills(rows); setRevision(value.revision);
      if ('name' in value) { setDetail(value); setDraft(input(value)); setSaved(input(value)); }
    }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [name]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const save = async () => {
    if (pending.current || !skills) return false;
    pending.current = true; setBusy(true); setError(undefined);
    try { await saveCommunitySkillPack(draft, revision, name || undefined); onSaved(); return true; }
    catch (failure) { setError(failure); return false; } finally { pending.current = false; setBusy(false); }
  };
  const guard = useDraftGuard(dirty, save, () => setDraft(saved), busy);
  const remove = async () => {
    if (!detail || pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { await removeCommunitySkillPack(name, deleteSkills, detail.revision); onSaved(); }
    catch (failure) { setError(failure); setRemoving(false); } finally { pending.current = false; setBusy(false); }
  };
  const move = (index: number, direction: number) => { const names = [...draft.skills]; [names[index], names[index + direction]] = [names[index + direction]!, names[index]!]; setDraft({ ...draft, skills: names }); };
  return <><CommunityDialog drawer drawerClassName="plugin-drawer" eyebrow={t('Skill pack details')} title={name || t('Create skill pack')} closeLabel={t('Close skill pack details')} busy={busy} onClose={() => guard.request(onClose)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(onClose)}>{t('Cancel')}</Button><Button isDisabled={busy || !skills || !dirty || !draft.name || !draft.description} onPress={() => { void save(); }}>{t('Save skill pack')}</Button></>}>
    {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {!skills ? <p role="status">{t('Loading…')}</p> : <div className="plugin-access-template">
      <CommunityField label={t('Pack name')} value={draft.name} disabled={busy} onChange={value => setDraft({ ...draft, name: value })} required/>
      <CommunityField label={t('Pack description')} value={draft.description} disabled={busy} onChange={value => setDraft({ ...draft, description: value })} required/>
      <section className="group-grants" aria-label={t('Pack skills')}><h3>{t('Pack skills')}</h3><p>{t('Select skills from the library. References follow the current skill version.')}</p><div className="group-grants-list">{skills.map(skill => <div className="group-grant-item" key={skill.name}><Checkbox isSelected={draft.skills.includes(skill.name)} isDisabled={busy || !!skill.conflict && !draft.skills.includes(skill.name)} onChange={checked => setDraft({ ...draft, skills: checked ? [...draft.skills, skill.name] : draft.skills.filter(name => name !== skill.name) })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{skill.name}</Checkbox.Content></Checkbox><p className="text-sm text-muted">{skill.description}</p></div>)}</div></section>
      {draft.skills.length ? <section aria-label={t('Skill order')}><h3>{t('Skill order')}</h3>{draft.skills.map((skill, index) => <div key={skill} className="flex items-center gap-2 py-2"><span className="grow">{index + 1}. {skill}</span><Button size="sm" variant="tertiary" isDisabled={busy || index === 0} aria-label={t('Move {name} up', { name: skill })} onPress={() => move(index, -1)}>↑</Button><Button size="sm" variant="tertiary" isDisabled={busy || index === draft.skills.length - 1} aria-label={t('Move {name} down', { name: skill })} onPress={() => move(index, 1)}>↓</Button></div>)}</section> : null}
      <TextField value={draft.instructions} onChange={value => setDraft({ ...draft, instructions: value })} isDisabled={busy} fullWidth variant="secondary"><Label>{t('Orchestration instructions (optional)')}</Label><TextArea rows={8}/></TextField><p>{t('Instructions become an additional skill named after this pack. The name must be unique.')}</p>
      <Checkbox isSelected={draft.published} isDisabled={busy} onChange={published => setDraft({ ...draft, published })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{t('Published to marketplace')}</Checkbox.Content></Checkbox>
      {name ? <Button variant="danger" isDisabled={busy || dirty} onPress={() => setRemoving(true)}>{t('Remove skill pack')}</Button> : null}
    </div>}
  </CommunityDialog>
  {removing && detail ? <CommunityDialog title={t('Remove skill pack')} busy={busy} onClose={() => setRemoving(false)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => setRemoving(false)}>{t('Cancel')}</Button><Button variant="danger" isDisabled={busy} onPress={() => { void remove(); }}>{t('Confirm removal')}</Button></>}><p>{t('Only the pack is removed by default. Library skills remain available.')}</p><Checkbox isSelected={deleteSkills} isDisabled={busy} onChange={setDeleteSkills}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{t('Also delete eligible skills')}</Checkbox.Content></Checkbox>
    <p>{t('Affected groups')}: {detail.removal.groups.map(group => group.name).join(', ') || '—'}</p><p>{t('{count} member selections', { count: deleteSkills ? detail.removal.selectedMembersWithSkills : detail.removal.selectedMembers })}</p>
    {deleteSkills ? <><h3>{t('Skills to delete')}</h3><p>{detail.removal.deleting.join(', ') || '—'}</p><h3>{t('Skills to retain')}</h3>{detail.removal.retained.map(skill => <p key={skill.name}>{skill.name}: {skill.reasons.map(reason => t(reason === 'other-pack' ? 'Used by another pack' : 'Directly granted to a group')).join(', ')}</p>)}</> : null}<CommunityMessage status="warning" title={t('Changes apply to new sessions. Running tasks using this skill may fail.')}/>
  </CommunityDialog> : null}{guard.dialog}</>;
}
