import { useId, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import { Label } from '@heroui/react/label';
import { PLUGIN_UPLOAD_MAX_BYTES } from '../../src/domain/plugin-library';
import { uploadCommunityPlugin } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';
import { useDraftGuard } from './useDraftGuard';

export default function CommunityPluginUploadDialog({ onClose, onAdded, replacing }: { replacing?: string; onClose: () => void; onAdded: () => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const pending = useRef(false);
  const id = useId();
  const valid = file !== undefined && file.name.endsWith('.tgz') && file.size > 0 && file.size <= PLUGIN_UPLOAD_MAX_BYTES;
  const save = async () => {
    if (!file || !valid || pending.current) return false;
    pending.current = true; setBusy(true); setError(undefined);
    try { await uploadCommunityPlugin(file, replacing); onAdded(); return true; }
    catch (failure) { setError(failure); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  const guard = useDraftGuard(Boolean(file), save, () => setFile(undefined), busy);
  return <><CommunityDialog title={t('Upload plugin archive')} busy={busy} onClose={() => guard.request(onClose)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(onClose)}>{t('Cancel')}</Button><Button type="submit" form={id} isDisabled={busy || !valid}>{t(busy ? 'Uploading and inspecting…' : 'Upload and precheck')}</Button></>}>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {replacing ? <p>{t('Upload a new version of {name}.', { name: replacing })}</p> : null}
    <form id={id} className="page-stack" onSubmit={event => { event.preventDefault(); void save(); }}>
      <Label htmlFor={`${id}-file`}>{t('Plugin archive (.tgz)')}</Label><Input id={`${id}-file`} type="file" accept=".tgz,application/gzip" disabled={busy} onChange={event => { setFile(event.target.files?.[0]); setError(undefined); }}/>
      <p>{t('Choose an npm pack archive, up to 50 MB. Package information is checked in an isolated container.')}</p>
      {file && !valid ? <CommunityMessage role="alert" status="danger" title={t('Choose a nonempty .tgz file no larger than 50 MB.')}/> : null}
      {busy ? <p role="status">{t('Uploading and inspecting…')}</p> : null}
    </form>
  </CommunityDialog>{guard.dialog}</>;
}
