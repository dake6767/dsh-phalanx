import { useEffect, useState, type FormEvent } from 'react';
import type { CommunityModelAction, CommunityModelSettings, CommunityProviderView } from '../../src/domain/admin-contract';
import { communityModels, updateCommunityModels } from './community-api';

export default function CommunityModelsPanel({ onConfigured }: { onConfigured: (configured: boolean) => void }) {
  const [settings, setSettings] = useState<CommunityModelSettings>();
  const [editing, setEditing] = useState<CommunityProviderView | 'new'>();
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [models, setModels] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void communityModels(controller.signal).then(setSettings).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load model settings');
    });
    return () => controller.abort();
  }, []);
  const edit = (provider: CommunityProviderView | 'new') => {
    setEditing(provider); setKey(''); setError(undefined); setNotice(undefined);
    setName(provider === 'new' ? '' : provider.name); setBaseUrl(provider === 'new' ? '' : provider.baseUrl);
    setModels(provider === 'new' ? '' : provider.models.map(model => model.name).join('\n'));
    setEnabled(provider === 'new' ? true : provider.enabled);
  };
  const save = async (input: CommunityModelAction, message: string) => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const updated = await updateCommunityModels(input); setSettings(updated);
      onConfigured(updated.providers.some(provider => provider.enabled && provider.hasApiKey && provider.models.some(model => model.enabled)));
      setNotice(message); setEditing(undefined); setKey('');
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to save model settings'); }
    finally { setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault(); if (!settings || !editing) return;
    const previous = editing === 'new' ? undefined : editing;
    const rows = models.split('\n').map(value => value.trim()).filter(Boolean).map(value => {
      const prior = previous?.models.find(model => model.name === value);
      return { ...(prior ? { id: prior.id } : {}), name: value, enabled: prior?.enabled ?? true };
    });
    void save({ revision: settings.revision, action: 'save-provider', provider: {
      ...(previous ? { id: previous.id } : {}), name, baseUrl, apiFormat: 'anthropic-messages', apiKey: key, enabled, models: rows,
    } }, 'Provider saved.');
  };
  const available = settings?.providers.filter(provider => provider.enabled).flatMap(provider => provider.models.filter(model => model.enabled)
    .map(model => ({ id: model.id, label: `${provider.name} / ${model.name}` }))) ?? [];
  return <section id="model-settings" className="panel model-settings" aria-label="Model settings">
    <div className="panel-heading"><h2>Model settings</h2><button disabled={busy || !settings} onClick={() => edit('new')}>Add provider</button></div>
    <p>Shared providers are managed by administrators and used by all members. Keys stay on the platform.</p>
    {!settings ? <p>Loading model configuration…</p> : <>
      {settings.providers.length === 0 && <p>No shared models configured.</p>}
      <label>Default shared model<select value={settings.defaultModelId ?? ''} disabled={busy || available.length === 0}
        onChange={event => { void save({ revision: settings.revision, action: 'set-default', defaultModelId: event.target.value }, 'Default model saved.'); }}>
        <option value="" disabled>Choose a shared model</option>{available.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
      </select></label>
      <p>Choose a replacement default before disabling or removing its current provider or model.</p>
      {settings.providers.map(provider => <article className="provider-row" key={provider.id}>
        <div className="panel-heading"><h3>{provider.name}</h3><div className="account-actions">
          <button className="secondary" disabled={busy} onClick={() => edit(provider)} aria-label={`Edit ${provider.name}`}>Edit</button>
          <button className="secondary" disabled={busy} aria-label={`${provider.enabled ? 'Disable' : 'Enable'} provider ${provider.name}`}
            onClick={() => { void save({ revision: settings.revision, action: 'save-provider', provider: { ...provider, enabled: !provider.enabled } }, 'Provider updated.'); }}>{provider.enabled ? 'Disable' : 'Enable'}</button>
          <button className="secondary danger" disabled={busy} aria-label={`Delete provider ${provider.name}`}
            onClick={() => { if (window.confirm(`Delete ${provider.name}? Existing conversations using its models must select another shared model.`)) void save({ revision: settings.revision, action: 'delete-provider', providerId: provider.id }, 'Provider deleted.'); }}>Delete</button>
        </div></div>
        <p>{provider.baseUrl} · Anthropic Messages · {provider.hasApiKey ? 'Key stored' : 'No key'} · {provider.enabled ? 'Enabled' : 'Disabled'}</p>
        <ul>{provider.models.map(model => <li key={model.id}>{model.name} · {model.enabled ? 'Enabled' : 'Disabled'}{' '}
          <button className="secondary" disabled={busy} aria-label={`${model.enabled ? 'Disable' : 'Enable'} model ${provider.name} / ${model.name}`}
            onClick={() => { void save({ revision: settings.revision, action: 'save-provider', provider: { ...provider, models: provider.models.map(row => row.id === model.id ? { ...row, enabled: !row.enabled } : row) } }, 'Model updated.'); }}>{model.enabled ? 'Disable' : 'Enable'}</button>
        </li>)}</ul>
      </article>)}
    </>}
    {error && <p role="alert" className="message error">{error}</p>}
    {notice && <p role="status" className="message success">{notice}</p>}
    {editing && <form className="provider-form" onSubmit={submit}>
      <h3>{editing === 'new' ? 'Add provider' : `Edit ${editing.name}`}</h3>
      <label>Provider name<input value={name} onChange={event => setName(event.target.value)} required disabled={busy}/></label>
      <label>Messages Base URL<input type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://provider.example/anthropic" required disabled={busy}/></label>
      <p>Include the provider's Messages prefix. The platform appends /v1/messages. DeepSeek: https://api.deepseek.com/anthropic. Volcengine Coding Plan: https://ark.cn-beijing.volces.com/api/coding.</p>
      <label>API format<select disabled><option>Anthropic Messages</option></select></label>
      <label>API key<input type="password" autoComplete="new-password" value={key} onChange={event => setKey(event.target.value)} required={editing === 'new'} disabled={busy}/></label>
      {editing !== 'new' && <p>Leave the key empty to retain the stored key.</p>}
      <label>Model identifiers<textarea aria-label="Model identifiers" rows={4} value={models} onChange={event => setModels(event.target.value)} required disabled={busy}/></label>
      <p>One identifier per line. Remove a line to delete that model.</p>
      <label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={busy}/>Provider enabled</label>
      <div className="dialog-actions"><button className="secondary" type="button" disabled={busy} onClick={() => { setEditing(undefined); setKey(''); }}>Cancel</button><button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save provider'}</button></div>
    </form>}
    {error && <button className="secondary" disabled={busy} onClick={() => { void communityModels().then(value => { setSettings(value); setError(undefined); setEditing(undefined); setKey(''); }).catch(failure => setError(failure instanceof Error ? failure.message : 'Unable to reload model settings')); }}>Reload settings</button>}
  </section>;
}
