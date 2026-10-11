import { useId, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import { Tabs } from '@heroui/react/tabs';
import CommunityField from './CommunityField';
import { Label } from '@heroui/react/label';
import type { CommunitySkillImportPreview } from '../../src/domain/admin-contract';
import { SKILL_IMPORT_MAX_BYTES } from '../../src/domain/skill-import';
import { importDraft, importInput } from './community-import-draft';
import CommunitySkillImportReview from './CommunitySkillImportReview';
import { changeCommunitySkill, previewSkillImport, confirmSkillImport, previewGitSkills } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';

export default function CommunitySkillUploadDialog({ onClose, onAdded, updateName }: { updateName?: string | undefined; onClose: () => void; onAdded: () => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [sourceKind, setSourceKind] = useState(updateName ? 'git' : 'zip'), [source, setSource] = useState('');
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<CommunitySkillImportPreview>();
  const [draft, setDraft] = useState<ReturnType<typeof importDraft>>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const pending = useRef(false), id = useId();
  const valid = sourceKind === 'git' ? !!updateName || source.trim().length > 0 : file !== undefined && file.name.toLowerCase().endsWith('.zip') && file.size > 0 && file.size <= SKILL_IMPORT_MAX_BYTES;
  const close = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { if (preview) await changeCommunitySkill({ action: 'cancel', token: preview.token }); onClose(); }
    catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  };
  const save = async () => {
    if (pending.current || !valid) return;
    pending.current = true; setBusy(true); setError(undefined);
    try {
      if (preview && draft) { await confirmSkillImport(importInput(preview, draft)); onAdded(); }
      else { const next = sourceKind === 'git' ? await previewGitSkills(source, updateName) : await previewSkillImport(file!); setPreview(next); setDraft(importDraft(next)); }
    } catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  };
  return <CommunityDialog title={t(updateName ? 'Check skill updates' : 'Import skill')} size={preview ? 'lg' : 'md'} busy={busy} onClose={() => { void close(); }} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => { void close(); }}>{t('Cancel')}</Button><Button form={id} type="submit" isDisabled={busy || !valid || !!preview && (!draft || (!importInput(preview, draft).names.length && !draft.removals.length) || preview.candidates.some(row => row.replacing && draft.names.includes(row.name) && row.name !== draft.note && !draft.replacements.includes(row.name)))}>{t(busy ? sourceKind === 'git' ? 'Fetching and inspecting…' : 'Uploading and inspecting…' : preview ? preview.candidates.some(row => row.replacing) ? 'Confirm replacement' : 'Confirm import' : updateName ? 'Check skill updates' : 'Preview skill')}</Button></>}>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <form id={id} className="page-stack" onSubmit={event => { event.preventDefault(); void save(); }}>
      <p>{t('Skills can execute scripts as the member. Review their contents before importing. Configure platform execution separately to prepare dependencies.')}</p>
      {!preview && !updateName ? <Tabs selectedKey={sourceKind} onSelectionChange={key => setSourceKind(String(key))} variant="secondary"><Tabs.ListContainer><Tabs.List aria-label={t('Import source')}><Tabs.Tab id="zip">{t('ZIP archive')}<Tabs.Indicator/></Tabs.Tab><Tabs.Tab id="git">{t('Git repository')}<Tabs.Indicator/></Tabs.Tab></Tabs.List></Tabs.ListContainer></Tabs> : null}
      {preview && draft ? <CommunitySkillImportReview preview={preview} draft={draft} onChange={setDraft} busy={busy}/> : sourceKind === 'git' ? <>{updateName ? <p>{t('Fetch the saved source and review changes before applying.')}</p> : <CommunityField label={t('Public Git source')} value={source} disabled={busy} onChange={setSource}/>}<p>{t('Public HTTPS repositories only. Fetching can take up to two minutes.')}</p></> : <>
        <Label htmlFor={`${id}-file`}>{t('Skill archive (.zip)')}</Label><Input id={`${id}-file`} type="file" accept=".zip,application/zip" disabled={busy} onChange={event => { setFile(event.target.files?.[0]); setError(undefined); }}/>
        <p>{t('Choose a ZIP up to 100 MB. Each extracted skill must be at most 20 MB.')}</p>
        {file && !valid ? <CommunityMessage role="alert" status="danger" title={t('Choose a nonempty .zip file no larger than 100 MB.')}/> : null}
      </>}
    </form>
  </CommunityDialog>;
}
