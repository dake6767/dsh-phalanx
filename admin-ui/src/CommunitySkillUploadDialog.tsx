import { useId, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import { Label } from '@heroui/react/label';
import type { CommunitySkillImportPreview } from '../../src/domain/admin-contract';
import { SKILL_IMPORT_MAX_BYTES } from '../../src/domain/skill-import';
import { importDraft, importInput } from './community-import-draft';
import CommunitySkillImportReview from './CommunitySkillImportReview';
import { changeCommunitySkill, previewSkillImport, confirmSkillImport } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';

export default function CommunitySkillUploadDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<CommunitySkillImportPreview>();
  const [draft, setDraft] = useState<ReturnType<typeof importDraft>>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const pending = useRef(false), id = useId();
  const valid = file !== undefined && file.name.toLowerCase().endsWith('.zip') && file.size > 0 && file.size <= SKILL_IMPORT_MAX_BYTES;
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
      if (preview && draft) { await confirmSkillImport(importInput(preview, draft)); onAdded(); }
      else { const next = await previewSkillImport(file); setPreview(next); setDraft(importDraft(next)); }
    } catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  };
  return <CommunityDialog title={t('Import skill')} size={preview ? 'lg' : 'md'} busy={busy} onClose={() => { void close(); }} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => { void close(); }}>{t('Cancel')}</Button><Button form={id} type="submit" isDisabled={busy || !valid || !!preview && (!draft || !importInput(preview, draft).names.length || preview.candidates.some(row => row.replacing && draft.names.includes(row.name) && row.name !== draft.note && !draft.replacements.includes(row.name)))}>{t(busy ? 'Uploading and inspecting…' : preview ? preview.candidates.some(row => row.replacing) ? 'Confirm replacement' : 'Confirm import' : 'Preview skill')}</Button></>}>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <form id={id} className="page-stack" onSubmit={event => { event.preventDefault(); void save(); }}>
      <p>{t('Skills can execute scripts as the member. Review their contents before importing. Configure platform execution separately to prepare dependencies.')}</p>
      {preview && draft ? <CommunitySkillImportReview preview={preview} draft={draft} onChange={setDraft} busy={busy}/> : <>
        <Label htmlFor={`${id}-file`}>{t('Skill archive (.zip)')}</Label><Input id={`${id}-file`} type="file" accept=".zip,application/zip" disabled={busy} onChange={event => { setFile(event.target.files?.[0]); setError(undefined); }}/>
        <p>{t('Choose a ZIP up to 100 MB. Each extracted skill must be at most 20 MB.')}</p>
        {file && !valid ? <CommunityMessage role="alert" status="danger" title={t('Choose a nonempty .zip file no larger than 100 MB.')}/> : null}
      </>}
    </form>
  </CommunityDialog>;
}
