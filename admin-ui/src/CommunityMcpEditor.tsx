import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Tabs } from '@heroui/react/tabs';
import { Checkbox } from '@heroui/react/checkbox';
import { Chip } from '@heroui/react/chip';
import type { CommunityMcpInput, CommunityMcpSettings, CommunityMcpTemplate } from '../../src/domain/admin-contract';
import { testCommunityMcp, updateCommunityMcp } from './community-api';
import { CommunityCopyError, usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';
import { useDraftGuard } from './useDraftGuard';
const inputOf = (value?: CommunityMcpSettings): CommunityMcpInput => ({ name: value?.name ?? 'p-', description: value?.description ?? '', url: value?.url ?? '', headers: value?.headers ?? [], query: value?.query ?? [], disabledTools: value?.disabledTools ?? [] });
export default function McpEditor({ value, onClose, onSaved, onRefreshed }: { value: CommunityMcpSettings | 'new'; onClose: () => void; onRefreshed: (row: CommunityMcpSettings) => void; onSaved: (rows: readonly CommunityMcpSettings[]) => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [settings, setSettings] = useState(value === 'new' ? undefined : value);
  const [initial, setInitial] = useState(() => inputOf(value === 'new' ? undefined : value));
  const [draft, setDraft] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const [credential, setCredential] = useState(''), [clearCredential, setClearCredential] = useState(false), [tab, setTab] = useState('basic');
  const id = useId(), pending = useRef(false), form = useRef<HTMLFormElement>(null);
  const valid = /^p-[A-Za-z0-9_-]{1,30}$/.test(draft.name) && draft.url.trim().length > 0;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || credential !== '' || clearCredential;
  // Refresh only on opening an already tested service; never poll in the background.
  useEffect(() => {
    if (value === 'new' || value.testStatus === 'untested') return;
    let active = true; pending.current = true; setBusy(true);
    void testCommunityMcp(value.name).then(next => { if (active) { setSettings(next); onRefreshed(next); } }).catch(failure => { if (active) setError(failure); }).finally(() => { if (active) { pending.current = false; setBusy(false); } });
    return () => { active = false; };
  }, [value]);
  const save = async (testing = false) => {
    if (pending.current || !valid) return false;
    const invalid = form.current?.querySelector<HTMLInputElement>(':invalid');
    if (invalid) { setTab(invalid.closest('[data-editor-tab]')?.getAttribute('data-editor-tab') ?? 'basic'); setError(new CommunityCopyError('Complete the required fields.')); return false; }
    pending.current = true; setBusy(true); setError(undefined);
    try {
      if (dirty || !settings) {
        const rows = await updateCommunityMcp({ action: 'save', service: { ...draft, ...(clearCredential ? { credential: '' } : credential ? { credential } : {}) }, create: !settings });
        const next = rows.find(row => row.name === draft.name)!;
        setSettings(next); setInitial(inputOf(next)); setDraft(inputOf(next)); setCredential(''); setClearCredential(false); onSaved(rows);
      }
      if (testing) { setTab('tools'); const next = await testCommunityMcp(draft.name); setSettings(next); onRefreshed(next); }
      else onClose();
      return true;
    } catch (failure) { setError(failure); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  const guard = useDraftGuard(dirty, () => save(), () => { setDraft(initial); setCredential(''); setClearCredential(false); }, busy);
  return <><CommunityDialog drawer={value !== 'new'} eyebrow={t('MCP library')} title={t(value === 'new' ? 'Add MCP service' : 'Edit MCP service')} busy={busy} onClose={() => guard.request(onClose)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(onClose)}>{t('Cancel')}</Button><Button type="submit" form={id} isDisabled={busy || !valid || !dirty}>{busy ? t('Saving…') : t('Save')}</Button></>}>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <form className="upstream-editor" ref={form} noValidate id={id} onSubmit={event => { event.preventDefault(); void save(); }}>
      <Tabs className="upstream-editor-tabs" selectedKey={tab} onSelectionChange={key => setTab(String(key))} variant="secondary">
        <Tabs.ListContainer><Tabs.List aria-label={t('Edit MCP service')}><Tabs.Tab id="basic">{t('Basic information')}<Tabs.Indicator/></Tabs.Tab><Tabs.Tab id="access">{t('Access settings')}<Tabs.Indicator/></Tabs.Tab><Tabs.Tab id="tools">{t('MCP tools')}<Tabs.Indicator/></Tabs.Tab></Tabs.List></Tabs.ListContainer>
        <Tabs.Panel id="basic" shouldForceMount data-editor-tab="basic">
          <CommunityField label={t('MCP service name')} value={draft.name} onChange={name => setDraft({ ...draft, name })} required readOnly={Boolean(settings)} disabled={busy} autoFocus pattern="p-[A-Za-z0-9_-]{1,30}" description={t('Use p- followed by up to 30 letters, digits, underscores or hyphens.')}/>
          <CommunityField label={t('Description')} value={draft.description} onChange={description => setDraft({ ...draft, description })} disabled={busy}/>
          <CommunityField label={t('Remote MCP address')} value={draft.url} onChange={url => setDraft({ ...draft, url })} type="url" required disabled={busy}/>
        </Tabs.Panel>
        <Tabs.Panel id="access" shouldForceMount data-editor-tab="access">
          <p className="upstream-editor-description">{t('Credentials stay on the platform. Address and header changes apply to the next request.')}</p>
          <Chip size="sm" variant="soft">{t(settings?.credentialConfigured ? 'Credential configured' : 'Credential not configured')}</Chip>
          <CommunityField label={t('Platform credential')} type="password" value={credential} onChange={next => { setCredential(next); setClearCredential(false); }} disabled={busy} autoComplete="new-password" description={t(settings?.credentialConfigured ? 'Leave blank to keep the saved credential.' : 'Enter the credential used by this upstream.')}/>
          {settings?.credentialConfigured ? <Button variant="secondary" isDisabled={busy} onPress={() => { setClearCredential(!clearCredential); setCredential(''); }}>{t(clearCredential ? 'Keep saved credential' : 'Clear saved credential')}</Button> : null}
          {clearCredential ? <p role="status">{t('The credential will be cleared when you save.')}</p> : null}
          <p>{t('Use {credential} for the saved secret. Fixed values replace member headers.')}</p>
          <TemplateFields kind="headers" rows={draft.headers ?? []} busy={busy} onChange={headers => setDraft({ ...draft, headers })}/>
          <TemplateFields kind="query" rows={draft.query ?? []} busy={busy} onChange={query => setDraft({ ...draft, query })}/>
        </Tabs.Panel>
        <Tabs.Panel id="tools" shouldForceMount data-editor-tab="tools">
          <p>{t('Testing saves your changes and discovers tools through the platform gateway. It does not enable administrator tools.')}</p>
          <Button variant="secondary" isDisabled={busy || !valid} onPress={() => { void save(true); }}>{t(busy ? 'Testing connection…' : 'Test connection')}</Button>
          {settings ? <CommunityMessage role="status" status={settings.testStatus === 'failed' ? 'danger' : settings.testStatus === 'passed' ? 'success' : 'warning'} title={t(settings.testStatus === 'passed' ? 'MCP connection passed.' : settings.testStatus === 'failed' ? 'MCP connection failed. Saved settings cannot be published.' : 'MCP connection has not been tested.')}/> : null}
          <p>{t('Checked tools are disabled for members. Newly discovered tools remain available.')}</p>
          <div className="group-grants-list">{settings?.tools.map(tool => <div className="group-grant-item" key={tool.name}><Checkbox isSelected={draft.disabledTools?.includes(tool.name) ?? false} isDisabled={busy} onChange={checked => setDraft({ ...draft, disabledTools: checked ? [...(draft.disabledTools ?? []), tool.name] : draft.disabledTools?.filter(name => name !== tool.name) })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{tool.name}</Checkbox.Content></Checkbox>{tool.isNew ? <Chip size="sm" variant="soft">{t('New tool')}</Chip> : null}<p className="text-sm text-muted">{tool.description}</p></div>)}</div>
        </Tabs.Panel>
      </Tabs>
    </form>
  </CommunityDialog>{guard.dialog}</>;
}
function TemplateFields({ kind, rows, busy, onChange }: { kind: 'headers' | 'query'; rows: readonly CommunityMcpTemplate[]; busy: boolean; onChange: (rows: readonly CommunityMcpTemplate[]) => void }) {
  const { t } = usePlatformLanguage();
  return <section className="page-stack"><h3>{t(kind === 'headers' ? 'Request headers' : 'Query parameters')}</h3>{rows.map((row, index) => <div className="plugin-environment-row upstream-header-row" key={index}>
    <CommunityField label={t(kind === 'headers' ? 'Header name' : 'Parameter name')} value={row.name} disabled={busy} required onChange={name => onChange(rows.map((item, i) => i === index ? { ...item, name } : item))}/>
    <CommunityField label={t(kind === 'headers' ? 'Header value' : 'Parameter value')} value={row.value} disabled={busy} onChange={value => onChange(rows.map((item, i) => i === index ? { ...item, value } : item))}/>
    <Button variant="tertiary" isDisabled={busy} onPress={() => onChange(rows.filter((_, i) => i !== index))}>{t(kind === 'headers' ? 'Remove header' : 'Remove parameter')}</Button>
  </div>)}<Button variant="secondary" isDisabled={busy || rows.length >= 32} onPress={() => onChange([...rows, { name: '', value: '' }])}>{t(kind === 'headers' ? 'Add header' : 'Add parameter')}</Button></section>;
}
