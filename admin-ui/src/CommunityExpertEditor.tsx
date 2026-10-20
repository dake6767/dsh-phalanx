import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Checkbox } from '@heroui/react/checkbox';
import { TextField } from '@heroui/react/textfield';
import { TextArea } from '@heroui/react/textarea';
import { Label } from '@heroui/react/label';
import type { CommunityExpertInput, CommunityExpertLibrary, CommunitySkillView, CommunitySkillPackView } from '../../src/domain/admin-contract';
import { communitySkills, communitySkillPacks, saveCommunityExpert } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import { useDraftGuard } from './useDraftGuard';
import CommunityDialog from './CommunityDialog';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';

const blank: CommunityExpertInput = { name: '', description: '', icon: '✦', persona: '', skills: [], skillPacks: [], plugins: [] };
export default function CommunityExpertEditor({ expert, plugins, revision, onClose, onSaved }: { expert?: CommunityExpertLibrary['experts'][number]; plugins: CommunityExpertLibrary['plugins']; revision: string; onClose: () => void; onSaved: () => void }) {
  const { t, errorText } = usePlatformLanguage();
  const initial: CommunityExpertInput = expert ? { name: expert.name, description: expert.description, icon: expert.icon, persona: expert.persona, skills: expert.skills, skillPacks: expert.skillPacks, plugins: expert.plugins } : blank;
  const [draft, setDraft] = useState(initial), [skills, setSkills] = useState<readonly CommunitySkillView[]>(), [packs, setPacks] = useState<readonly CommunitySkillPackView[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const pending = useRef(false), saved = useRef(initial), baseRevision = useRef(revision);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([communitySkills(controller.signal), communitySkillPacks(controller.signal)]).then(([skills, packs]) => {
      if (!controller.signal.aborted) { setSkills(skills); setPacks(packs.packs); }
    }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved.current);
  const save = async () => {
    if (pending.current || !skills) return false;
    pending.current = true; setBusy(true); setError(undefined);
    try { await saveCommunityExpert(draft, baseRevision.current, expert?.id); onSaved(); return true; }
    catch (failure) { setError(failure); return false; } finally { pending.current = false; setBusy(false); }
  };
  const guard = useDraftGuard(dirty, save, () => setDraft(saved.current), busy);
  return <><CommunityDialog drawer drawerClassName="plugin-drawer" title={t(expert ? 'Edit expert' : 'Create expert')} closeLabel={t('Close expert details')} busy={busy} onClose={() => guard.request(onClose)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(onClose)}>{t('Cancel')}</Button><Button isDisabled={busy || !skills || !dirty || !draft.name.trim() || !draft.description.trim() || !draft.persona.trim()} onPress={() => { void save(); }}>{t('Save expert')}</Button></>}>
    {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <div className="plugin-access-template">
      <CommunityField variant="secondary" label={t('Expert name')} value={draft.name} disabled={busy} onChange={name => setDraft({ ...draft, name })} required/>
      <CommunityField variant="secondary" label={t('Expert description')} value={draft.description} disabled={busy} onChange={description => setDraft({ ...draft, description })} required/>
      <CommunityField variant="secondary" label={t('Expert icon')} value={draft.icon} disabled={busy} onChange={icon => setDraft({ ...draft, icon })}/>
      <TextField variant="secondary" value={draft.persona} onChange={persona => setDraft({ ...draft, persona })} isDisabled={busy} isRequired fullWidth><Label>{t('Expert persona')}</Label><TextArea variant="secondary" rows={8}/></TextField>
      <CommunityMessage status="default" title={t('Every expert includes the standard file, terminal, search and subagent tools.')}/>
      <section className="group-grants" aria-label={t('Expert plugins')}><h3>{t('Expert plugins')}</h3><div className="group-grants-list">{plugins.map(row => <div className="group-grant-item" key={row.packageName}><Checkbox isSelected={draft.plugins?.includes(row.packageName) ?? false} isDisabled={busy || !row.eligible && !draft.plugins?.includes(row.packageName)} onChange={checked => setDraft({ ...draft, plugins: checked ? [...(draft.plugins ?? []), row.packageName] : draft.plugins?.filter(name => name !== row.packageName) })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{row.packageName}</Checkbox.Content></Checkbox><p>{row.eligible ? row.title : t('Unavailable plugins and plugins that change core entries cannot be included in an expert.')}</p></div>)}</div></section>
      {(['skills', 'skillPacks'] as const).map(kind => <section className="group-grants" key={kind} aria-label={t(kind === 'skills' ? 'Expert skills' : 'Expert skill packs')}><h3>{t(kind === 'skills' ? 'Expert skills' : 'Expert skill packs')}</h3><div className="group-grants-list">{(kind === 'skills' ? skills ?? [] : packs).map(row => <div className="group-grant-item" key={row.name}><Checkbox isSelected={draft[kind].includes(row.name)} isDisabled={busy || Boolean(row.conflict) && !draft[kind].includes(row.name)} onChange={checked => setDraft({ ...draft, [kind]: checked ? [...draft[kind], row.name] : draft[kind].filter(name => name !== row.name) })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{row.name}</Checkbox.Content></Checkbox><p className="text-sm text-muted">{row.description}</p></div>)}</div></section>)}
      <p>{t('Creating an expert does not publish it or grant it to any group.')}</p>
      <p>{t('Expert changes take effect after members restart their instances.')}</p>
    </div>
  </CommunityDialog>{guard.dialog}</>;
}
