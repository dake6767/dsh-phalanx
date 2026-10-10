import { useId, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import { Label } from '@heroui/react/label';
import type { CommunitySkillPreview } from '../../src/domain/admin-contract';
import { SKILL_MAX_BYTES } from '../../src/domain/skill-library';
import { changeCommunitySkill, uploadCommunitySkill } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';
import CommunitySkillContent from './CommunitySkillContent';

export default function CommunitySkillUploadDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<CommunitySkillPreview>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const pending = useRef(false), id = useId();
  const valid = file !== undefined && file.name.toLowerCase().endsWith('.zip') && file.size > 0 && file.size <= SKILL_MAX_BYTES;
  const close = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { if (preview) await changeCommunitySkill({ action: 'cancel', token: preview.token }); onClose(); }
    catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  };
  const save = async () => {
    if (pending.current || !file || !valid) return;
    pending.current = true; setBusy(true); setError(undefined);
    try {
      if (preview) { await changeCommunitySkill({ action: 'confirm', token: preview.token, revision: preview.revision }); onAdded(); }
      else setPreview(await uploadCommunitySkill(file));
    } catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  };
  return <CommunityDialog title={t('Import skill')} size={preview ? 'lg' : 'md'} busy={busy} onClose={() => { void close(); }} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => { void close(); }}>{t('Cancel')}</Button><Button form={id} type="submit" isDisabled={busy || !valid}>{t(busy ? 'Uploading and inspecting…' : preview ? preview.replacing ? 'Confirm replacement' : 'Confirm import' : 'Preview skill')}</Button></>}>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <form id={id} className="page-stack" onSubmit={event => { event.preventDefault(); void save(); }}>
      <p>{t('Skills can execute scripts as the member. Review their contents before importing. The platform does not scan code or prepare dependencies.')}</p>
      {preview ? <><div className="skill-preview-summary"><h2>{preview.name}</h2><p>{preview.description}</p></div>{preview.replacing ? <CommunityMessage status="warning" title={t('Changes apply to new sessions. Running tasks using this skill may fail.')}/> : null}<p>{t('{managed} managed members · {selected} member selections', { managed: preview.managedMembers, selected: preview.selectedMembers })}</p><CommunitySkillContent markdown={preview.markdown} files={preview.files}/></> : <>
        <Label htmlFor={`${id}-file`}>{t('Skill archive (.zip)')}</Label><Input id={`${id}-file`} type="file" accept=".zip,application/zip" disabled={busy} onChange={event => { setFile(event.target.files?.[0]); setError(undefined); }}/>
        <p>{t('Choose one skill ZIP, up to 20 MB before and after extraction.')}</p>
        {file && !valid ? <CommunityMessage role="alert" status="danger" title={t('Choose a nonempty .zip file no larger than 20 MB.')}/> : null}
      </>}
    </form>
  </CommunityDialog>;
}
