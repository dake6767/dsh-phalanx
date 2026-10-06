import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Switch } from '@heroui/react/switch';
import type { CommunityModelAction, CommunityModelSettings, CommunityProviderView } from '../../src/domain/admin-contract';
import { CommunityApiRequestError, communityModels, updateCommunityModels } from './community-api';
import CommunityField from './CommunityField';
import CommunityDialog from './CommunityDialog';
import { useDraftGuard } from './useDraftGuard';
type ModelDraft = { id?: string; row: string; name: string; enabled: boolean };
type ProviderDraft = { id?: string; name: string; baseUrl: string; apiKey: string; enabled: boolean; models: ModelDraft[] };
function draftOf(provider?: CommunityProviderView): ProviderDraft {
  return { ...(provider ? { id: provider.id } : {}), name: provider?.name ?? '', baseUrl: provider?.baseUrl ?? '', apiKey: '', enabled: provider?.enabled ?? true,
    models: provider ? provider.models.map(model => ({ ...model, row: model.id })) : [{ row: crypto.randomUUID(), name: '', enabled: true }] };
}
function configured(settings: CommunityModelSettings) { return settings.providers.some(provider => provider.enabled && provider.hasApiKey && provider.models.some(model => model.enabled)); }
export default function CommunityModelsPanel({ onConfigured }: { onConfigured: (configured: boolean) => void }) {
  const [settings, setSettings] = useState<CommunityModelSettings>();
  const current = useRef<CommunityModelSettings | undefined>(undefined);
  current.current = settings;
  const [draft, setDraft] = useState<ProviderDraft>();
  const baseline = useRef('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [deleting, setDeleting] = useState<CommunityProviderView>();
  const select = (provider?: CommunityProviderView) => { const next = draftOf(provider); baseline.current = JSON.stringify(next); setDraft(next); setError(undefined); setConflict(false); setNotice(undefined); };
  useEffect(() => {
    const controller = new AbortController();
    void communityModels(controller.signal).then(value => { setSettings(value); if (value.providers[0]) select(value.providers[0]); }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load model settings');
    });
    return () => controller.abort();
  }, []);
  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline.current);
  const update = (patch: Partial<ProviderDraft>) => setDraft(value => value ? { ...value, ...patch } : value);
  const mutate = async (action: CommunityModelAction, message: string): Promise<CommunityModelSettings | undefined> => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError(undefined); setNotice(undefined); setConflict(false);
    try { const value = await updateCommunityModels(action); current.current = value; setSettings(value); onConfigured(configured(value)); setNotice(message); return value; }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to save model settings'); setConflict(failure instanceof CommunityApiRequestError && failure.status === 409); }
    finally { submitting.current = false; setBusy(false); }
  };
  const save = async () => {
    if (!settings || !draft || submitting.current) return false;
    if (!form.current?.checkValidity()) { setError('Complete the required connection and model fields.'); return false; }
    const value = await mutate({ revision: settings.revision, action: 'save-provider', provider: { ...draft, apiFormat: 'anthropic-messages', models: draft.models.map(({ id, name, enabled }) => ({ ...(id ? { id } : {}), name, enabled })) } }, 'Provider saved.');
    if (!value) return false;
    const provider = draft.id ? value.providers.find(row => row.id === draft.id) : value.providers.find(row => !settings.providers.some(previous => previous.id === row.id));
    if (provider) { const next = draftOf(provider); baseline.current = JSON.stringify(next); setDraft(next); }
    return true;
  };
  const guard = useDraftGuard(dirty, save, () => { if (draft) setDraft(JSON.parse(baseline.current) as ProviderDraft); }, busy);
  const reload = async () => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true);
    try { const value = await communityModels(); setSettings(value); select(value.providers.find(row => row.id === draft?.id) ?? value.providers[0]); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to reload settings'); }
    finally { submitting.current = false; setBusy(false); }
  };
  const available = settings?.providers.filter(provider => provider.enabled).flatMap(provider => provider.models.filter(model => model.enabled).map(model => ({ id: model.id, label: `${provider.name} / ${model.name}` }))) ?? [];
  return <section id="model-settings" className="model-settings" aria-label="Model settings">
    <div className="panel default-model"><label>Default shared model<select value={settings?.defaultModelId ?? ''} disabled={busy || !available.length}
      onChange={event => { const id = event.target.value; guard.request(() => { if (current.current) void mutate({ revision: current.current.revision, action: 'set-default', defaultModelId: id }, 'Default model saved.'); }); }}>
      <option value="" disabled>Choose a shared model</option>{available.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
      <p>Choose a replacement default before disabling or deleting its current provider or model.</p></div>
    {error ? <p role="alert" className="message error">{error}</p> : null}{notice ? <p role="status" className="message success">{notice}</p> : null}
    {conflict || !settings && error ? <Button variant="secondary" isDisabled={busy} onPress={() => guard.request(() => { void reload(); })}>Reload settings</Button> : null}
    {!settings && !error ? <p role="status">Loading model configuration…</p> : settings ? <div className="provider-layout">
      <aside className="panel provider-picker" aria-label="Providers"><div className="panel-heading"><h2>Providers</h2><Button size="sm" variant="secondary" isDisabled={busy} onPress={() => guard.request(() => select())}>Add provider</Button></div>
        {!settings.providers.length ? <p>No shared models configured.</p> : settings.providers.map(provider => <Button key={provider.id} className="provider-choice" variant={draft?.id === provider.id ? 'secondary' : 'tertiary'} aria-label={`Select provider ${provider.name}`} aria-pressed={draft?.id === provider.id} isDisabled={busy}
          onPress={() => { if (draft?.id !== provider.id) guard.request(() => select(provider)); }}><span>{provider.name}<small>{provider.models.length} models · {provider.enabled ? 'Enabled' : 'Disabled'}</small></span></Button>)}</aside>
      {draft ? <form ref={form} className="panel provider-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className="panel-heading"><h2>{draft.id ? 'Provider configuration' : 'Add provider'}</h2>{dirty ? <span className="badge">Unsaved changes</span> : null}</div>
        <CommunityField label="Provider name" value={draft.name} onChange={name => update({ name })} required disabled={busy}/>
        <CommunityField label="Messages Base URL" type="url" value={draft.baseUrl} onChange={baseUrl => update({ baseUrl })} required disabled={busy}/>
        <p>Use the provider’s Messages prefix. The platform appends /v1/messages.</p>
        <p className="muted">Protocol: Anthropic Messages</p>
        <CommunityField label="API key" type="password" autoComplete="new-password" value={draft.apiKey} onChange={apiKey => update({ apiKey })} required={!draft.id} disabled={busy}/>
        {draft.id ? <p>Leave the key empty to retain the stored key. Stored keys are never displayed.</p> : null}
        <Switch isSelected={draft.enabled} onChange={enabled => update({ enabled })} isDisabled={busy}><Switch.Control><Switch.Thumb/></Switch.Control><Switch.Content>Provider enabled</Switch.Content></Switch>
        <div className="panel-heading"><h3>Models</h3><Button type="button" size="sm" variant="secondary" isDisabled={busy} onPress={() => update({ models: [...draft.models, { row: crypto.randomUUID(), name: '', enabled: true }] })}>Add model</Button></div>
        {!draft.models.length ? <p>Add at least one model before saving.</p> : draft.models.map((model, index) => <div className="model-draft-row" key={model.row}>
          <CommunityField label={`Model identifier ${index + 1}`} value={model.name} onChange={name => update({ models: draft.models.map(row => row.row === model.row ? { ...row, name } : row) })} required disabled={busy}/>
          <Switch aria-label={`Model ${index + 1} enabled`} isSelected={model.enabled} onChange={enabled => update({ models: draft.models.map(row => row.row === model.row ? { ...row, enabled } : row) })} isDisabled={busy}><Switch.Control><Switch.Thumb/></Switch.Control><Switch.Content>Enabled</Switch.Content></Switch>
          <Button type="button" size="sm" variant="tertiary" aria-label={`Remove model ${index + 1}`} isDisabled={busy} onPress={() => update({ models: draft.models.filter(row => row.row !== model.row) })}>Remove</Button>
        </div>)}
        <div className="dialog-actions">{draft.id ? <Button type="button" variant="danger" isDisabled={busy} onPress={() => guard.request(() => setDeleting(settings.providers.find(row => row.id === draft.id)))}>Delete provider</Button> : null}
          <Button type="button" variant="tertiary" isDisabled={busy || !dirty} onPress={() => guard.request(() => select(current.current?.providers.find(row => row.id === draft.id) ?? current.current?.providers[0]))}>Discard draft</Button><Button type="submit" isDisabled={busy || Boolean(draft.id && !dirty)}>{busy ? 'Saving…' : 'Save provider'}</Button></div>
      </form> : <div className="panel"><h2>Select a provider</h2><p>Select a provider to edit its connection and models, or add a provider.</p></div>}
    </div> : null}
    {deleting ? <CommunityDialog title={`Delete provider: ${deleting.name}`} busy={busy} onClose={() => setDeleting(undefined)}><p>Existing conversations using these models must select another shared model. This action removes the provider configuration.</p><div className="dialog-actions"><Button variant="tertiary" isDisabled={busy} onPress={() => setDeleting(undefined)}>Cancel</Button><Button variant="danger" isDisabled={busy} onPress={() => { void mutate({ revision: settings!.revision, action: 'delete-provider', providerId: deleting.id }, 'Provider deleted.').then(value => { setDeleting(undefined); if (value) { if (value.providers[0]) select(value.providers[0]); else setDraft(undefined); } }); }}>Confirm deletion</Button></div></CommunityDialog> : null}
    {guard.dialog}
  </section>;
}
