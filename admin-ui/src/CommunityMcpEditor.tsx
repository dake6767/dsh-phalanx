import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Tabs } from '@heroui/react/tabs';
import { Checkbox } from '@heroui/react/checkbox';
import { Chip } from '@heroui/react/chip';
import type { CommunityMcpInput, CommunityMcpSettings, CommunityMcpTemplate } from '../../src/domain/admin-contract';
import { communityMcp, testCommunityMcp, updateCommunityMcp } from './community-api';
import { CommunityCopyError, usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityField from './CommunityField';
import CommunitySelect from './CommunitySelect';
import type { McpImportDraft } from '../../src/domain/mcp-import';
import CommunityMessage from './CommunityMessage';
import { useDraftGuard } from './useDraftGuard';
const inputOf = (value?: CommunityMcpSettings): CommunityMcpInput => ({ run: value?.run ?? null, required: value?.required ?? false, name: value?.name ?? 'p-', description: value?.description ?? '', url: value?.url ?? '', headers: value?.headers ?? [], query: value?.query ?? [], disabledTools: value?.disabledTools ?? [] });
export default function McpEditor({ value, seed, progress, onClose, onSaved, onRefreshed }: { value: CommunityMcpSettings | 'new'; seed?: McpImportDraft; progress?: string; onClose: () => void; onRefreshed: (row: CommunityMcpSettings) => void; onSaved: (rows: readonly CommunityMcpSettings[]) => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [settings, setSettings] = useState(value === 'new' ? undefined : value);
  const [initial, setInitial] = useState(() => seed ? { ...seed.input, credential: undefined, credentials: undefined } : inputOf(value === 'new' ? undefined : value));
  const [draft, setDraft] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const [credential, setCredential] = useState(seed?.input.credential ?? ''), [clearCredential, setClearCredential] = useState(false), [tab, setTab] = useState('basic');
  const [credentials, setCredentials] = useState<Record<string, string>>({ ...seed?.input.credentials });
  const id = useId(), pending = useRef(false), form = useRef<HTMLFormElement>(null);
  const valid = /^p-[A-Za-z0-9_-]{1,30}$/.test(draft.name) && (draft.run ? draft.run.command.trim().length > 0 : draft.url.trim().length > 0);
  const dirty = !settings || Object.keys(credentials).length > 0 || JSON.stringify(draft) !== JSON.stringify(initial) || credential !== '' || clearCredential;
  // Refresh only on opening an already tested service; never poll in the background.
  useEffect(() => {
    if (value === 'new' || value.testStatus === 'untested') return;
    let active = true; pending.current = true; setBusy(true);
    void testCommunityMcp(value.name).then(next => { if (active) { setSettings(next); onRefreshed(next); } }).catch(failure => { if (active) setError(failure); }).finally(() => { if (active) { pending.current = false; setBusy(false); } });
    return () => { active = false; };
  }, [value]);
  useEffect(() => {
    if (settings?.preparation?.stage !== 'preparing') return;
    const controller = new AbortController();
    const timer = setInterval(() => { void communityMcp(controller.signal).then(rows => {
      const next = rows.find(row => row.name === settings.name);
      if (next && !controller.signal.aborted) { setSettings(next); onRefreshed(next); }
    }).catch(failure => { if (!controller.signal.aborted) setError(failure); }); }, 1500);
    return () => { clearInterval(timer); controller.abort(); };
  }, [settings?.name, settings?.preparation?.stage]);
  const reprepare = async () => {
    if (!settings || pending.current || dirty) return;
    pending.current = true; setBusy(true); setError(undefined);
    try {
      const rows = await updateCommunityMcp({ action: 'prepare', name: settings.name });
      const next = rows.find(row => row.name === settings.name)!; setSettings(next); onRefreshed(next);
    } catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  };
  const save = async (testing = false) => {
    if (pending.current || !valid) return false;
    const invalid = form.current?.querySelector<HTMLInputElement>(':invalid');
    if (invalid) { setTab(invalid.closest('[data-editor-tab]')?.getAttribute('data-editor-tab') ?? 'basic'); setError(new CommunityCopyError('Complete the required fields.')); return false; }
    pending.current = true; setBusy(true); setError(undefined);
    try {
      if (dirty || !settings) {
        const rows = await updateCommunityMcp({ action: 'save', service: { ...draft, credentials, ...(clearCredential ? { credential: '' } : credential ? { credential } : {}) }, create: !settings, originalName: settings?.name });
        const next = rows.find(row => row.name === draft.name)!;
        setSettings(next); setInitial(inputOf(next)); setDraft(inputOf(next)); setCredential(''); setCredentials({}); setClearCredential(false); onSaved(rows);
      }
      if (testing) { setTab('tools'); const next = await testCommunityMcp(draft.name); setSettings(next); onRefreshed(next); }
      else onClose();
      return true;
    } catch (failure) { setError(failure); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  const publish = async () => {
    if (!settings || pending.current || dirty) return;
    pending.current = true; setBusy(true); setError(undefined);
    try {
      const rows = await updateCommunityMcp({ action: 'publish', name: settings.name, published: !settings.published });
      const next = rows.find(row => row.name === settings.name)!; setSettings(next); onSaved(rows);
    } catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  };
  const guard = useDraftGuard(dirty, () => save(), () => { setDraft(initial); setCredential(''); setClearCredential(false); }, busy);
  return <><CommunityDialog drawer={value !== 'new'} eyebrow={t('MCP library')} title={t(value === 'new' ? 'Add MCP service' : 'Edit MCP service')} busy={busy} onClose={() => guard.request(onClose)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(onClose)}>{t('Cancel')}</Button><Button type="submit" form={id} isDisabled={busy || !valid || !dirty}>{busy ? t('Saving…') : t('Save')}</Button></>}>
    {progress ? <p>{progress}</p> : null}
    {seed?.credentialSources.length ? <p>{t('Moved credentials from: {sources}', { sources: seed.credentialSources.join(', ') })}</p> : null}
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <form className="upstream-editor" ref={form} noValidate id={id} onSubmit={event => { event.preventDefault(); void save(); }}>
      <Tabs className="upstream-editor-tabs" selectedKey={tab} onSelectionChange={key => setTab(String(key))} variant="secondary">
        <Tabs.ListContainer><Tabs.List aria-label={t('Edit MCP service')}><Tabs.Tab id="basic">{t('Basic information')}<Tabs.Indicator/></Tabs.Tab><Tabs.Tab id="access">{t('Access settings')}<Tabs.Indicator/></Tabs.Tab><Tabs.Tab id="tools">{t('MCP tools')}<Tabs.Indicator/></Tabs.Tab></Tabs.List></Tabs.ListContainer>
        <Tabs.Panel id="basic" shouldForceMount data-editor-tab="basic">
          <CommunityField label={t('MCP service name')} value={draft.name} onChange={name => setDraft({ ...draft, name })} required disabled={busy} autoFocus pattern="p-[A-Za-z0-9_-]{1,30}" description={t('Use p- followed by up to 30 letters, digits, underscores or hyphens.')}/>
          <CommunityField label={t('Description')} value={draft.description} onChange={description => setDraft({ ...draft, description })} disabled={busy}/>
          <CommunitySelect label={t('Run location')} value={draft.run?.location ?? 'remote'} options={[{ id: 'remote', label: t('Remote service') }, { id: 'shared', label: t('Shared run') }, { id: 'member', label: t('Member container run') }, { id: 'independent', label: t('Independent member run (unavailable)'), disabled: true }]} disabled={busy} onChange={location => setDraft({ ...draft, run: location === 'remote' ? null : { location: location as 'shared' | 'member', command: draft.run?.command ?? '', args: draft.run?.args ?? [], env: draft.run?.env ?? [], prepareCommand: draft.run?.prepareCommand ?? '' } })}/>
          <p>{t('Independent member run is not available. Services needing both platform credentials and member files are unsupported.')}</p>
          {draft.run ? <>
            <CommunityField label={t('MCP command')} value={draft.run.command} required disabled={busy} onChange={command => setDraft({ ...draft, run: { ...draft.run!, command } })}/>
            <TemplateFields kind="args" rows={draft.run.args.map(value => ({ name: '', value }))} busy={busy} onChange={args => setDraft({ ...draft, run: { ...draft.run!, args: args.map(row => row.value) } })}/>
            <TemplateFields kind="env" rows={draft.run.env} busy={busy} onChange={env => setDraft({ ...draft, run: { ...draft.run!, env } })}/>
            <CommunityField label={t('Preparation command')} value={draft.run.prepareCommand} disabled={busy} onChange={prepareCommand => setDraft({ ...draft, run: { ...draft.run!, prepareCommand } })}/>
            <p>{t('Save runtime settings first, then prepare dependencies before testing or enabling tools.')}</p>
            {settings?.preparation ? <CommunityMessage role="status" status={settings.preparation.stage === 'failed' ? 'danger' : settings.preparation.stage === 'ready' ? 'success' : 'accent'} title={t(settings.preparation.stage === 'failed' ? 'Preparation failed' : settings.preparation.stage === 'ready' ? 'Dependencies ready' : 'Preparing dependencies…')}><time dateTime={new Date(settings.preparation.updatedAt).toISOString()}>{new Date(settings.preparation.updatedAt).toLocaleString()}</time></CommunityMessage> : null}
            {settings?.preparation?.log ? <details><summary>{t('Preparation log')}</summary><pre className="plugin-preparation-log">{settings.preparation.log}</pre></details> : null}
            {settings ? <Button variant="secondary" isDisabled={busy || dirty || settings.preparation?.stage === 'preparing'} onPress={() => { void reprepare(); }}>{t('Prepare again')}</Button> : null}
            {draft.run.location === 'shared' ? <p>{t('Shared run keeps platform credentials outside member spaces. Each member uses an isolated process with read-only dependencies.')}</p> : null}
            {settings?.preparation?.isolated === false ? <CommunityMessage role="status" status="warning" title={t('Shared run is not isolated. Development only.')}/> : null}
            {draft.run.location === 'member' ? <p>{t('Prepared dependencies are shared read-only. Use {dependencies} in arguments to refer to their directory. Tool filtering is for usability, not a security boundary.')}</p> : null}
          </> : <CommunityField label={t('Remote MCP address')} value={draft.url} onChange={url => setDraft({ ...draft, url })} type="url" required disabled={busy}/>}
          <Checkbox isSelected={draft.required ?? false} isDisabled={busy} onChange={required => setDraft({ ...draft, required })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{t('Required MCP service')}</Checkbox.Content></Checkbox>
          <p>{t('Members with a grant cannot disable a required service, including administrators.')}</p>
          {settings ? <><p role="status">{t(settings.published ? 'MCP service is published.' : 'MCP service is not published.')}</p><Button variant="secondary" isDisabled={busy || dirty || (!settings.published && settings.testStatus !== 'passed')} onPress={() => { void publish(); }}>{t(settings.published ? 'Unpublish MCP service' : 'Publish MCP service')}</Button>{dirty ? <p>{t('Save changes before publishing.')}</p> : null}</> : null}
        </Tabs.Panel>
        <Tabs.Panel id="access" shouldForceMount data-editor-tab="access">
          <p className="upstream-editor-description">{t('Credentials stay on the platform. Address and header changes apply to the next request.')}</p>
          <Chip size="sm" variant="soft">{t(settings?.credentialConfigured ? 'Credential configured' : 'Credential not configured')}</Chip>
          <CommunityField label={t('Platform credential')} type="password" value={credential} onChange={next => { setCredential(next); setClearCredential(false); }} disabled={busy} autoComplete="new-password" description={t(settings?.credentialConfigured ? 'Leave blank to keep the saved credential.' : 'Enter the credential used by this upstream.')}/>
          {settings?.credentialConfigured ? <Button variant="secondary" isDisabled={busy} onPress={() => { setClearCredential(!clearCredential); setCredential(''); }}>{t(clearCredential ? 'Keep saved credential' : 'Clear saved credential')}</Button> : null}
          {clearCredential ? <p role="status">{t('The credential will be cleared when you save.')}</p> : null}
          {Array.from(new Set([...settings?.credentialNames ?? [], ...Object.keys(credentials)])).map(name => <CommunityField key={name} label={t('Platform credential {name}', { name })} type="password" value={credentials[name] ?? ''} disabled={busy} onChange={value => setCredentials({ ...credentials, [name]: value })} description={t('Leave unchanged to keep the saved credential. Enter an empty value to clear it.')}/>)}
          {draft.run?.location === 'member' ? <p>{t('Member container run cannot use platform credentials. Clear credentials and their templates first.')}</p> : null}
          <p>{t('Use {credential} for the saved secret. Fixed values replace member headers.')}</p>
          {!draft.run ? <><TemplateFields kind="headers" rows={draft.headers ?? []} busy={busy} onChange={headers => setDraft({ ...draft, headers })}/>
          <TemplateFields kind="query" rows={draft.query ?? []} busy={busy} onChange={query => setDraft({ ...draft, query })}/></> : null}
        </Tabs.Panel>
        <Tabs.Panel id="tools" shouldForceMount data-editor-tab="tools">
          <p>{t(draft.run?.location === 'member' ? 'Testing starts your member instance and discovers tools through its prepared stdio process. It does not enable your MCP service.' : 'Testing saves your changes and discovers tools through the platform gateway. It does not enable administrator tools.')}</p>
          <Button variant="secondary" isDisabled={busy || !valid || (Boolean(draft.run) && (dirty || settings?.preparation?.stage !== 'ready'))} onPress={() => { void save(true); }}>{t(busy ? 'Testing connection…' : 'Test connection')}</Button>
          {settings ? <CommunityMessage role="status" status={settings.testStatus === 'failed' ? 'danger' : settings.testStatus === 'passed' ? 'success' : 'warning'} title={t(settings.testStatus === 'passed' ? 'MCP connection passed.' : settings.testStatus === 'failed' ? 'MCP connection failed. Saved settings cannot be published.' : 'MCP connection has not been tested.')}/> : null}
          <p>{t('Checked tools are disabled for members. Newly discovered tools remain available.')}</p>
          <div className="group-grants-list">{settings?.tools.map(tool => <div className="group-grant-item" key={tool.name}><Checkbox isSelected={draft.disabledTools?.includes(tool.name) ?? false} isDisabled={busy} onChange={checked => setDraft({ ...draft, disabledTools: checked ? [...(draft.disabledTools ?? []), tool.name] : draft.disabledTools?.filter(name => name !== tool.name) })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{tool.name}</Checkbox.Content></Checkbox>{tool.isNew ? <Chip size="sm" variant="soft">{t('New tool')}</Chip> : null}<p className="text-sm text-muted">{tool.description}</p></div>)}</div>
        </Tabs.Panel>
      </Tabs>
    </form>
  </CommunityDialog>{guard.dialog}</>;
}
function TemplateFields({ kind, rows, busy, onChange }: { kind: 'headers' | 'query' | 'env' | 'args'; rows: readonly CommunityMcpTemplate[]; busy: boolean; onChange: (rows: readonly CommunityMcpTemplate[]) => void }) {
  const { t } = usePlatformLanguage();
  const labels = { headers: ['Request headers', 'Header name', 'Header value', 'Remove header', 'Add header'], query: ['Query parameters', 'Parameter name', 'Parameter value', 'Remove parameter', 'Add parameter'], env: ['Environment variables', 'Variable name', 'Variable value', 'Remove variable', 'Add variable'], args: ['Command arguments', 'Argument', 'Argument', 'Remove argument', 'Add argument'] } as const;
  const copy = labels[kind];
  return <section className="page-stack"><h3>{t(copy[0])}</h3>{rows.map((row, index) => <div className="plugin-environment-row upstream-header-row" key={index}>
    {kind !== 'args' ? <CommunityField label={t(copy[1])} value={row.name} disabled={busy} required onChange={name => onChange(rows.map((item, i) => i === index ? { ...item, name } : item))}/> : null}
    <CommunityField label={t(copy[2])} value={row.value} disabled={busy} onChange={value => onChange(rows.map((item, i) => i === index ? { ...item, value } : item))}/>
    <Button variant="tertiary" isDisabled={busy} onPress={() => onChange(rows.filter((_, i) => i !== index))}>{t(copy[3])}</Button>
  </div>)}<Button variant="secondary" isDisabled={busy || rows.length >= 32} onPress={() => onChange([...rows, { name: '', value: '' }])}>{t(copy[4])}</Button></section>;
}
