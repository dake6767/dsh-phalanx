import { TextField } from '@heroui/react/textfield';
import { TextArea } from '@heroui/react/textarea';
import { Label } from '@heroui/react/label';
import CommunitySelect from './CommunitySelect';
import CommunityUpstreamTest from './CommunityUpstreamTest';
import { useEffect, useId, useRef, useState } from 'react';
import { Tabs } from '@heroui/react/tabs';
import { Button } from '@heroui/react/button';
import { Chip } from '@heroui/react/chip';
import { Card } from '@heroui/react/card';
import type { CommunityPluginUpstreamInput, CommunityPluginUpstreamView } from '../../src/domain/admin-contract';
import { communityPluginUpstreams, updateCommunityPluginUpstreams } from './community-api';
import { CommunityCopyError, usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';
import { useDraftGuard } from './useDraftGuard';

export default function CommunityPluginUpstreams({ packageName, onChanged }: { packageName: string; onChanged?: () => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [revision, setRevision] = useState(0);
  const [rows, setRows] = useState<readonly CommunityPluginUpstreamView[]>();
  const [editing, setEditing] = useState<CommunityPluginUpstreamView | null>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    void communityPluginUpstreams(packageName, controller.signal).then(setRows).catch(error => { if (!controller.signal.aborted) setError(error); });
    return () => controller.abort();
  }, [packageName]);
  return <section className="plugin-upstreams" aria-label={t('Plugin upstreams')}>
    <div className="plugin-section-heading"><h3>{t('Plugin upstreams')}</h3><Button size="sm" variant="secondary" isDisabled={rows === undefined} onPress={() => setEditing(null)}>{t('Add upstream')}</Button></div><p>{t('Testing checks the address, credential and headers only. It does not verify that the plugin calls through the platform.')}</p><p>{t('Credentials stay on the platform. Address and header changes apply to the next request.')}</p>
    {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {rows === undefined ? <p role="status">{t('Loading…')}</p> : rows.map(row => <Card className="plugin-upstream-card" key={row.name}><Card.Content>
      <div className="plugin-section-heading"><strong>{row.name}</strong><Chip size="sm" variant="soft">{t(row.hasCredential ? 'Credential configured' : 'Credential not configured')}</Chip></div>
      <p className="plugin-upstream-address">{row.baseUrl}</p><div className="plugin-upstream-actions"><Button variant="secondary" onPress={() => setEditing(row)}>{t('Edit upstream')}</Button>
      <CommunityUpstreamTest key={`${revision}:${JSON.stringify(row)}`} packageName={packageName} name={row.name} ready={row.hasCredential && Boolean(row.testRequest)}/>
    </div></Card.Content></Card>)}
    {editing !== undefined ? <UpstreamEditor packageName={packageName} existing={editing} names={rows?.map(row => row.name) ?? []} onClose={() => setEditing(undefined)} onSaved={next => { setRows(next); onChanged?.(); setRevision(value => value + 1); setEditing(undefined); }}/> : null}
  </section>;
}
function UpstreamEditor({ packageName, existing, names, onClose, onSaved }: { packageName: string; existing: CommunityPluginUpstreamView | null; names: readonly string[]; onClose: () => void; onSaved: (rows: readonly CommunityPluginUpstreamView[]) => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [name, setName] = useState(existing?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
  const [credential, setCredential] = useState('');
  const [clearCredential, setClearCredential] = useState(false);
  const [headers, setHeaders] = useState<CommunityPluginUpstreamInput['headers']>(existing?.headers ?? [{ name: 'Authorization', value: 'Bearer {credential}' }]);
  const [testMethod, setTestMethod] = useState(existing?.testRequest?.method ?? 'GET');
  const [testPath, setTestPath] = useState(existing?.testRequest?.path ?? '');
  const [testBody, setTestBody] = useState(existing?.testRequest?.body === undefined ? '' : JSON.stringify(existing.testRequest.body, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [deleting, setDeleting] = useState(false);
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const [editorTab, setEditorTab] = useState('basic');
  const testDirty = testMethod !== (existing?.testRequest?.method ?? 'GET') || testPath !== (existing?.testRequest?.path ?? '') || testBody !== (existing?.testRequest?.body === undefined ? '' : JSON.stringify(existing.testRequest.body, null, 2));
  const dirty = testDirty || name !== (existing?.name ?? '') || baseUrl !== (existing?.baseUrl ?? '') || credential !== '' || clearCredential || JSON.stringify(headers) !== JSON.stringify(existing?.headers ?? [{ name: 'Authorization', value: 'Bearer {credential}' }]);
  const save = async () => {
    if (busy) return false;
    if (!existing && names.includes(name)) { setEditorTab('basic'); setError(new CommunityCopyError('This upstream name already exists.')); return false; }
    const invalid = form.current?.querySelector<HTMLInputElement>(':invalid');
    if (invalid) {
      setEditorTab(invalid.closest('[data-editor-tab]')?.getAttribute('data-editor-tab') ?? 'basic');
      setError(new CommunityCopyError('Complete the required fields.')); return false;
    }
    setBusy(true); setError(undefined);
    try {
      let body: unknown;
      if (testBody.trim() && testPath) { try { body = JSON.parse(testBody); } catch { setEditorTab('test'); throw new CommunityCopyError('Enter a valid JSON test body.'); } }
      const testRequest = testPath ? { method: testMethod, path: testPath, ...(body === undefined ? {} : { body }) } : null;
      const next = await updateCommunityPluginUpstreams(packageName, { action: 'save', upstream: { name, baseUrl, headers, testRequest, ...(clearCredential ? { credential: '' } : credential ? { credential } : {}) } });
      setCredential(''); onSaved(next); return true;
    } catch (error) { setError(error); return false; } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError(undefined);
    try { onSaved(await updateCommunityPluginUpstreams(packageName, { action: 'delete', name })); }
    catch (error) { setDeleting(false); setError(error); } finally { setBusy(false); }
  };
  const guard = useDraftGuard(dirty, save, () => setCredential(''), busy);
  return <><CommunityDialog size="lg" title={t(existing ? 'Edit upstream' : 'Add upstream')} busy={busy} onClose={() => guard.request(onClose)} footer={<div className="upstream-editor-actions">
    {existing ? <Button className="upstream-delete-action" variant="danger-soft" isDisabled={busy} onPress={() => setDeleting(true)}>{t('Delete upstream')}</Button> : null}
    <Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(onClose)}>{t('Cancel')}</Button><Button type="submit" form={id} isDisabled={busy || !name || !baseUrl || (!existing && names.includes(name))}>{t('Save changes')}</Button>
  </div>}>
    <form ref={form} noValidate id={id} className="upstream-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
      {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
      <Tabs className="upstream-editor-tabs" selectedKey={editorTab} onSelectionChange={key => setEditorTab(String(key))} variant="secondary">
        <Tabs.ListContainer><Tabs.List aria-label={t(existing ? 'Edit upstream' : 'Add upstream')}>
          <Tabs.Tab id="basic">{t('Basic information')}<Tabs.Indicator/></Tabs.Tab>
          <Tabs.Tab id="headers">{t('Request headers')}<Tabs.Indicator/></Tabs.Tab>
          <Tabs.Tab id="test">{t('Test request')}<Tabs.Indicator/></Tabs.Tab>
        </Tabs.List></Tabs.ListContainer>
        <Tabs.Panel id="basic" shouldForceMount data-editor-tab="basic">
          <p className="upstream-editor-description">{t('Credentials stay on the platform. Address and header changes apply to the next request.')}</p>
      <CommunityField label={t('Upstream name')} value={name} onChange={setName} readOnly={existing !== null} disabled={busy} required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}" description={t('Use a unique name with letters, digits, underscores or hyphens.')}/>
      {!existing && names.includes(name) ? <CommunityMessage status="danger" title={t('This upstream name already exists.')}/> : null}
      <CommunityField label={t('Upstream address')} type="url" value={baseUrl} onChange={setBaseUrl} disabled={busy} required description={t('HTTP(S) addresses, including private networks, are supported.')}/>
      <CommunityField label={t('Platform credential')} type="password" value={credential} onChange={value => { setCredential(value); setClearCredential(false); }} disabled={busy} autoComplete="new-password" description={t(existing?.hasCredential ? 'Leave blank to keep the saved credential.' : 'Enter the credential used by this upstream.')}/>
      {existing?.hasCredential ? <Button variant="secondary" isDisabled={busy} onPress={() => { setClearCredential(!clearCredential); setCredential(''); }}>{t(clearCredential ? 'Keep saved credential' : 'Clear saved credential')}</Button> : null}
      {clearCredential ? <p role="status">{t('The credential will be cleared when you save.')}</p> : null}
      </Tabs.Panel>
      <Tabs.Panel id="headers" shouldForceMount data-editor-tab="headers">
      <p className="upstream-editor-description">{t('Use {credential} for the saved secret. Fixed values replace member headers.')}</p>
      {headers.map((header, index) => <div className="plugin-environment-row upstream-header-row" key={index}>
        <CommunityField label={t('Header name')} value={header.name} disabled={busy} required onChange={name => setHeaders(rows => rows.map((row, i) => i === index ? { ...row, name } : row))}/>
        <CommunityField label={t('Header value')} value={header.value} disabled={busy} onChange={value => setHeaders(rows => rows.map((row, i) => i === index ? { ...row, value } : row))}/>
        <Button variant="tertiary" isDisabled={busy} onPress={() => setHeaders(rows => rows.filter((_, i) => i !== index))}>{t('Remove header')}</Button>
      </div>)}
      <Button variant="secondary" isDisabled={busy} onPress={() => setHeaders(rows => [...rows, { name: '', value: '' }])}>{t('Add header')}</Button>
      </Tabs.Panel>
      <Tabs.Panel id="test" shouldForceMount data-editor-tab="test">
      <p>{t('Testing checks the address, credential and headers only. It does not verify that the plugin calls through the platform.')}</p>
      <CommunitySelect label={t('Test method')} value={testMethod} onChange={setTestMethod} options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(value => ({ id: value, label: value }))}/>
      <CommunityField label={t('Test path')} value={testPath} onChange={setTestPath} disabled={busy} description={t('Use a path such as /search. Leave blank to remove the test request.')}/>
      <TextField value={testBody} onChange={setTestBody} isDisabled={busy} variant="secondary" fullWidth><Label>{t('Test JSON body (optional)')}</Label><TextArea className="plugin-yaml-input" rows={7}/></TextField>
      </Tabs.Panel>
      </Tabs>
    </form>
  </CommunityDialog>{guard.dialog}{deleting ? <CommunityDialog title={t('Delete upstream')} busy={busy} onClose={() => setDeleting(false)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => setDeleting(false)}>{t('Cancel')}</Button><Button variant="danger" isDisabled={busy} onPress={() => { void remove(); }}>{t('Confirm')}</Button></>}><p>{t('Delete this upstream and its saved credential?')}</p></CommunityDialog> : null}</>;
}
