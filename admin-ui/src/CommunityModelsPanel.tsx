import { usePlatformLanguage, CommunityCopyError } from './CommunityLanguage';
import type { PlatformMessageKey } from '../../src/domain/platform-copy';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Switch } from '@heroui/react/switch';
import type { CommunityModelAction, CommunityModelSettings, CommunityProviderView } from '../../src/domain/admin-contract';
import { CommunityApiRequestError, communityModels, updateCommunityModels } from './community-api';
import CommunityField from './CommunityField';
import CommunitySelect from './CommunitySelect';
import CommunityDialog from './CommunityDialog';
import { useDraftGuard } from './useDraftGuard';
import CommunityMessage from './CommunityMessage';
import CommunityIcon from './CommunityIcon';
type ModelDraft = { id?: string; row: string; name: string; enabled: boolean };
type ProviderDraft = { id?: string; name: string; baseUrl: string; apiKey: string; enabled: boolean; models: ModelDraft[] };
// View-local row keys only; persistent model IDs are assigned by the server.
let nextDraftRow = 0;
function newModelDraft(): ModelDraft {
  return { row: `draft:${nextDraftRow++}`, name: '', enabled: true };
}
function draftOf(provider?: CommunityProviderView): ProviderDraft {
  return { ...(provider ? { id: provider.id } : {}), name: provider?.name ?? '', baseUrl: provider?.baseUrl ?? '', apiKey: '', enabled: provider?.enabled ?? true,
    models: provider ? provider.models.map(model => ({ ...model, row: `saved:${model.id}` })) : [newModelDraft()] };
}
function configured(settings: CommunityModelSettings) { return settings.providers.some(provider => provider.enabled && provider.hasApiKey && provider.models.some(model => model.enabled)); }
export default function CommunityModelsPanel({ onConfigured }: { onConfigured: (configured: boolean) => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [settings, setSettings] = useState<CommunityModelSettings>();
  const current = useRef<CommunityModelSettings | undefined>(undefined);
  current.current = settings;
  const [draft, setDraft] = useState<ProviderDraft>();
  const baseline = useRef('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const providerName = useRef<HTMLInputElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    if (!focusRequest) return;
    // Transfer focus after the draft dialog's focus scope has restored its trigger.
    const frame = requestAnimationFrame(() => {
      providerName.current?.focus({ preventScroll: true });
      providerName.current?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);
  const [error, setError] = useState<unknown>();
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<PlatformMessageKey>();
  const [deleting, setDeleting] = useState<CommunityProviderView>();
  const select = (provider?: CommunityProviderView) => { const next = draftOf(provider); baseline.current = JSON.stringify(next); setDraft(next); setError(undefined); setConflict(false); setNotice(undefined); };
  useEffect(() => {
    const controller = new AbortController();
    void communityModels(controller.signal).then(value => { setSettings(value); if (value.providers[0]) select(value.providers[0]); }).catch(failure => {
      if (!controller.signal.aborted) setError(failure);
    });
    return () => controller.abort();
  }, []);
  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline.current);
  const update = (patch: Partial<ProviderDraft>) => setDraft(value => value ? { ...value, ...patch } : value);
  const mutate = async (action: CommunityModelAction, message: PlatformMessageKey): Promise<CommunityModelSettings | undefined> => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError(undefined); setNotice(undefined); setConflict(false);
    try { const value = await updateCommunityModels(action); current.current = value; setSettings(value); onConfigured(configured(value)); setNotice(message); return value; }
    catch (failure) { setError(failure); setConflict(failure instanceof CommunityApiRequestError && failure.status === 409); }
    finally { submitting.current = false; setBusy(false); }
  };
  const save = async () => {
    if (!settings || !draft || submitting.current) return false;
    if (!form.current?.checkValidity()) { setError(new CommunityCopyError('Complete the required connection and model fields.')); return false; }
    const value = await mutate({ revision: settings.revision, action: 'save-provider', provider: { ...draft, apiFormat: 'anthropic-messages', models: draft.models.map(({ id, name, enabled }) => ({ ...(id ? { id } : {}), name, enabled })) } }, 'Provider saved.');
    if (!value) return false;
    const provider = draft.id ? value.providers.find(row => row.id === draft.id) : value.providers.find(row => !settings.providers.some(previous => previous.id === row.id));
    if (provider) { const next = draftOf(provider); baseline.current = JSON.stringify(next); setDraft(next); }
    return true;
  };
  const guard = useDraftGuard(dirty, save, () => { if (draft) setDraft(JSON.parse(baseline.current) as ProviderDraft); }, busy);
  const addProvider = () => {
    const focus = () => setFocusRequest(value => value + 1);
    if (draft && !draft.id) focus();
    else guard.request(() => { select(); focus(); });
  };
  const reload = async () => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true);
    try { const value = await communityModels(); setSettings(value); select(value.providers.find(row => row.id === draft?.id) ?? value.providers[0]); }
    catch (failure) { setError(failure); }
    finally { submitting.current = false; setBusy(false); }
  };
  const available = settings?.providers.filter(provider => provider.enabled).flatMap(provider => provider.models.filter(model => model.enabled).map(model => ({ id: model.id, label: `${provider.name} / ${model.name}` }))) ?? [];
  return <>
    <section className="page-heading"><div><h1>{t("Model management")}<span className="heading-dot" aria-hidden="true">.</span></h1><p>{t("Configure shared providers and the platform default model.")}</p></div><Button className="primary-action" aria-pressed={Boolean(draft && !draft.id)} isDisabled={busy || !settings} onPress={addProvider}><CommunityIcon name="plus" size={16}/>{t("Add provider")}</Button></section>
    <section id="model-settings" className="model-settings" aria-label={t("Model settings")}>
    <div className="panel settings-panel default-model"><div className="panel-top"><div><h2>{t("Default shared model")}</h2><p>{t("Choose a replacement default before disabling or deleting its current provider or model.")}</p></div></div><div className="settings-panel-body"><CommunitySelect hideLabel label={t("Default shared model")} className="default-model-select" value={settings?.defaultModelId ?? null} options={available} placeholder={t("Choose a shared model")} disabled={busy || !available.length}
      onChange={id => guard.request(() => { if (current.current) void mutate({ revision: current.current.revision, action: 'set-default', defaultModelId: id }, 'Default model saved.'); })}/></div></div>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}{notice ? <CommunityMessage role="status" status="success" title={t(notice)}/> : null}
    {conflict || !settings && error ? <Button variant="secondary" isDisabled={busy} onPress={() => guard.request(() => { void reload(); })}>{t("Reload settings")}</Button> : null}
    {!settings && !error ? <p role="status">{t("Loading model configuration…")}</p> : settings ? <div className="provider-layout">
      <aside className="panel settings-panel provider-picker" aria-label={t("Providers")}><div className="panel-top"><h2>{t("Providers")}</h2></div><div className="provider-options settings-panel-body">
        {!settings.providers.length ? <p>{t("No shared models configured.")}</p> : settings.providers.map(provider => <Button key={provider.id} className="provider-choice" variant={draft?.id === provider.id ? 'secondary' : 'tertiary'} aria-label={t("Select provider {name}", { name: provider.name })} aria-pressed={draft?.id === provider.id} isDisabled={busy}
          onPress={() => { if (draft?.id !== provider.id) guard.request(() => select(provider)); }}><span>{provider.name}<small>{t('{count} models · {status}', { count: provider.models.length, status: t(provider.enabled ? "Enabled" : "Disabled") })}</small></span></Button>)}</div></aside>
      {draft ? <form ref={form} className="panel settings-panel provider-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className="panel-top"><h2>{draft.id ? t("Provider configuration") : t("Add provider")}</h2>{dirty ? <span className="badge">{t("Unsaved changes")}</span> : null}</div>
        <div className="settings-panel-body provider-form-fields"><CommunityField inputRef={providerName} label={t("Provider name")} value={draft.name} onChange={name => update({ name })} required disabled={busy}/>
        <CommunityField label={t("Messages Base URL")} type="url" value={draft.baseUrl} onChange={baseUrl => update({ baseUrl })} required disabled={busy}
          description={t("Use the provider’s Messages prefix. The platform appends /v1/messages. Protocol: Anthropic Messages.")}/>
        <CommunityField label={t("API key")} type="password" autoComplete="new-password" value={draft.apiKey} onChange={apiKey => update({ apiKey })} required={!draft.id} disabled={busy}
          description={draft.id ? t("Leave the key empty to retain the stored key. Stored keys are never displayed.") : undefined}/>
        <Switch isSelected={draft.enabled} onChange={enabled => update({ enabled })} isDisabled={busy}><Switch.Content><Switch.Control><Switch.Thumb/></Switch.Control>{t("Provider enabled")}</Switch.Content></Switch>
        <div className="panel-heading"><h3>{t("Models")}</h3><Button type="button" size="sm" variant="secondary" isDisabled={busy} onPress={() => update({ models: [...draft.models, newModelDraft()] })}>{t("Add model")}</Button></div>
        {!draft.models.length ? <p>{t("Add at least one model before saving.")}</p> : draft.models.map((model, index) => <div className="model-draft-row" key={model.row}>
          <CommunityField label={t("Model identifier {index}", { index: index + 1 })} value={model.name} onChange={name => update({ models: draft.models.map(row => row.row === model.row ? { ...row, name } : row) })} required disabled={busy}/>
          <Switch aria-label={t("Model {index} enabled", { index: index + 1 })} isSelected={model.enabled} onChange={enabled => update({ models: draft.models.map(row => row.row === model.row ? { ...row, enabled } : row) })} isDisabled={busy}><Switch.Content><Switch.Control><Switch.Thumb/></Switch.Control>{t("Enabled")}</Switch.Content></Switch>
          <Button type="button" size="sm" variant="tertiary" aria-label={t("Remove model {index}", { index: index + 1 })} isDisabled={busy} onPress={() => update({ models: draft.models.filter(row => row.row !== model.row) })}>{t("Remove")}</Button>
        </div>)}
        <div className="dialog-actions">{draft.id ? <Button type="button" variant="danger" isDisabled={busy} onPress={() => guard.request(() => setDeleting(settings.providers.find(row => row.id === draft.id)))}>{t("Delete provider")}</Button> : null}
          <Button type="button" variant="tertiary" isDisabled={busy || !dirty} onPress={() => guard.request(() => select(current.current?.providers.find(row => row.id === draft.id) ?? current.current?.providers[0]))}>{t("Discard draft")}</Button><Button type="submit" isDisabled={busy || Boolean(draft.id && !dirty)}>{busy ? t("Saving…") : t("Save provider")}</Button></div>
        </div>
      </form> : <div className="panel settings-panel provider-empty"><div className="panel-top"><div><h2>{t("Select a provider")}</h2><p>{t("Select a provider to edit its connection and models, or add a provider.")}</p></div></div></div>}
    </div> : null}
    {deleting ? <CommunityDialog title={t("Delete provider: {name}", { name: deleting.name })} busy={busy} onClose={() => setDeleting(undefined)} footer={<><Button variant="tertiary" isDisabled={busy} onPress={() => setDeleting(undefined)}>{t("Cancel")}</Button><Button variant="danger" isDisabled={busy} onPress={() => { void mutate({ revision: settings!.revision, action: 'delete-provider', providerId: deleting.id }, 'Provider deleted.').then(value => { setDeleting(undefined); if (value) { if (value.providers[0]) select(value.providers[0]); else setDraft(undefined); } }); }}>{t("Confirm deletion")}</Button></>}><p>{t("Existing conversations using these models must select another shared model. This action removes the provider configuration.")}</p></CommunityDialog> : null}
    {guard.dialog}
  </section></>;
}
