import { useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Chip } from '@heroui/react/chip'
import type { CommunityInstalledServices } from '../../src/domain/admin-contract'
import type { InstalledServiceChange, InstalledServiceOwner } from '../../src/domain/installed-services'
import { changeCommunityInstalledServices, communityInstalledServices } from './community-installed-services-api'
import { CommunityApiRequestError } from './community-api'
import CommunityDialog from './CommunityDialog'
import CommunityField from './CommunityField'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityMessage from './CommunityMessage'
import CommunityPluginUpstreams from './CommunityPluginUpstreams'
import CommunitySelect from './CommunitySelect'
import { missingServiceFields } from './community-catalog-setup'

type Backend = CommunityInstalledServices['slots'][number]['backends'][number]

export default function CommunityInstalledServiceSettings({
  kind,
  name,
  onDraft,
  onChanged,
}: InstalledServiceOwner & { onDraft: (key: string, dirty: boolean, busy: boolean) => void; onChanged?: () => void }) {
  const { t, locale, errorText } = usePlatformLanguage()
  const [view, setView] = useState<CommunityInstalledServices>()
  const [chosenBackends, setChosenBackends] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({})
  const [loading, setLoading] = useState(true)
  const [loadingError, setLoadingError] = useState<unknown>()
  const [error, setError] = useState<unknown>()
  const [saved, setSaved] = useState(false)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<Extract<InstalledServiceChange, { confirmed: true }>>()
  const writing = useRef(false)
  const loadedRevision = useRef<string | undefined>(undefined)
  const dirty = Object.values(drafts).some(draft => Object.keys(draft).length > 0)
  useEffect(() => {
    const key = JSON.stringify([kind, name])
    onDraft(key, dirty, busy)
    return () => onDraft(key, false, false)
  }, [kind, name, dirty, busy, onDraft])
  useEffect(() => {
    const controller = new AbortController()
    void communityInstalledServices({ kind, name }, controller.signal)
      .then(next => {
        if (controller.signal.aborted) return
        setLoading(false)
        const nextRevision = JSON.stringify([next.identity, next.revision])
        if (loadedRevision.current && loadedRevision.current !== nextRevision) {
          setDrafts({})
          setConfirmation(undefined)
        }
        loadedRevision.current = nextRevision
        setView(next)
        setLoadingError(undefined)
        setError(undefined)
      })
      .catch(failure => {
        if (controller.signal.aborted) return
        setLoading(false)
        if (failure instanceof CommunityApiRequestError && failure.code === 'suite-not-installed') {
          setView(undefined)
          setLoadingError(undefined)
        } else setLoadingError(failure)
      })
    return () => controller.abort()
  }, [kind, name, reload])

  async function change(input: InstalledServiceChange) {
    if (!view || loading || writing.current) return
    writing.current = true
    setBusy(true)
    setError(undefined)
    setSaved(false)
    try {
      const next = await changeCommunityInstalledServices({ kind, name }, view.revision, input)
      loadedRevision.current = JSON.stringify([next.identity, next.revision])
      setView(next)
      if (input.action === 'save') {
        const key = JSON.stringify([input.slot, input.backend])
        setDrafts(current => {
          const remaining = { ...current }
          delete remaining[key]
          return remaining
        })
      }
      setConfirmation(undefined)
      setSaved(true)
      onChanged?.()
    } catch (failure) {
      setError(failure)
      setConfirmation(undefined)
    } finally {
      writing.current = false
      setBusy(false)
    }
  }

  function backendForm(slot: string, backend: Backend) {
    const key = JSON.stringify([slot, backend.id])
    const values = drafts[key] ?? {}
    const edited = Object.keys(values).length > 0
    const missing =
      kind === 'plugin' && !backend.complete
        ? missingServiceFields(backend.fields, Object.fromEntries(backend.fields.filter(field => field.configured).map(field => [field.name, 'saved'])))
        : []
    const status = (
      <Chip size="sm" variant="soft" color={backend.enabled ? 'success' : 'default'}>
        {t(backend.enabled ? (kind === 'plugin' ? 'Access configured' : 'Enabled') : missing.length ? 'Access not configured' : 'Disabled')}
      </Chip>
    )
    const form = (
      <div className="page-stack">
        {missing.length ? <p>{t('Fields to configure: {fields}', { fields: missing.map(field => field.label?.[locale] ?? field.name).join(' · ') })}</p> : null}
        {backend.fields.map(field => {
          const original = field.value ?? ''
          return (
            <div className="page-stack" key={field.name}>
              <CommunityField
                label={field.label?.[locale] ?? field.name}
                type={field.type === 'secret' ? 'password' : field.type}
                autoComplete={field.type === 'secret' ? 'new-password' : 'off'}
                description={[
                  field.label ? field.name : '',
                  field.required
                    ? t('Required field')
                    : field.requiredGroup
                      ? t('Fill one of {fields}').replace(
                          '{fields}',
                          backend.fields
                            .filter(other => other.requiredGroup === field.requiredGroup)
                            .map(other => other.label?.[locale] ?? other.name)
                            .join(' / '),
                        )
                      : '',
                  field.type === 'secret' ? t(field.configured ? 'Saved credential' : 'No saved credential') : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
                disabled={busy || loading}
                value={values[field.name] ?? original}
                onChange={value => {
                  setSaved(false)
                  setDrafts(current => {
                    const next = { ...current[key], [field.name]: value }
                    if (value === original) delete next[field.name]
                    return { ...current, [key]: next }
                  })
                }}
              />
              {field.type === 'secret' && !field.configured && view?.retainedLegacyFields?.includes(field.name) ? (
                <div>
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={busy || loading || edited}
                    onPress={() => setConfirmation({ slot, backend: backend.id, field: field.name, action: 'adopt-legacy', confirmed: true })}
                  >
                    {t('Use retained {field}', { field: field.name })}
                  </Button>
                </div>
              ) : null}
              {field.type === 'secret' && field.configured ? (
                <div>
                  <Button
                    size="sm"
                    variant="tertiary"
                    isDisabled={busy || loading || edited}
                    onPress={() => setConfirmation({ slot, backend: backend.id, field: field.name, action: 'clear', confirmed: true })}
                  >
                    {t('Clear {field}', { field: field.name })}
                  </Button>
                </div>
              ) : null}
            </div>
          )
        })}
        <div className="catalog-entry-actions">
          <Button
            size="sm"
            variant="secondary"
            isDisabled={busy || loading || !edited}
            onPress={() => void change({ slot, backend: backend.id, action: 'save', values })}
          >
            {t('Save configuration')}
          </Button>
          <Button
            size="sm"
            variant="tertiary"
            isDisabled={busy || loading || edited || (!backend.complete && !backend.enabled)}
            onPress={() => void change({ slot, backend: backend.id, action: backend.enabled ? 'disable' : 'enable' })}
          >
            {t(backend.enabled ? 'Disable' : 'Enable')}
          </Button>
        </div>
      </div>
    )
    return kind === 'plugin' ? (
      <div className="page-stack" key={backend.id}>
        {status}
        {form}
      </div>
    ) : (
      <details key={backend.id} className="catalog-service-backend">
        <summary>
          {backend.label[locale]} {status}
        </summary>
        {form}
      </details>
    )
  }

  const confirmationTitle =
    confirmation?.action === 'adopt-legacy'
      ? t('Use retained {field}', { field: confirmation.field })
      : t(confirmation?.action === 'discard-legacy' ? 'Discard retained credential' : 'Clear saved credential')
  if ((!view || (kind === 'plugin' && !view.slots.length && !view.retainedLegacyFields?.length)) && !loadingError) {
    if (loading) return <p role="status">{t('Loading…')}</p>
    return kind === 'plugin' ? <CommunityPluginUpstreams packageName={name} mode="catalog" onChanged={onChanged} /> : null
  }
  const title = t(kind === 'plugin' ? 'Access settings' : 'Service backends')
  return (
    <section className="plugin-detail-section" aria-label={title}>
      <h2>{title}</h2>
      {loadingError ? (
        <CommunityMessage role="alert" status="danger" title={t('Service configuration could not be loaded.')}>
          <p>{errorText(loadingError)}</p>
        </CommunityMessage>
      ) : null}
      {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
      {loadingError || error ? (
        <Button
          size="sm"
          variant="secondary"
          isDisabled={busy}
          onPress={() => {
            setLoading(true)
            setReload(value => value + 1)
          }}
        >
          {t('Retry loading configuration')}
        </Button>
      ) : null}
      {saved ? <CommunityMessage role="status" status="success" title={t('Service configuration saved.')} /> : null}
      {view?.slots.map(slot => {
        const chosen =
          slot.backends.find(backend => backend.id === chosenBackends[slot.id]) ?? slot.backends.find(backend => backend.enabled) ?? slot.backends[0]
        return (
          <section className="catalog-service-slot" key={slot.id} aria-label={slot.label[locale]}>
            <h3>{slot.label[locale]}</h3>
            {slot.jsonSettings ? <p>{t('Plugin upstream {name}. Changes apply at the next instance startup.', { name: slot.jsonSettings.upstream })}</p> : null}
            {slot.jsonSettings?.personal ? <p role="status">{t('Some members have switched to personal plugin settings.')}</p> : null}
            {kind === 'plugin' && chosen ? (
              <>
                {slot.backends.length > 1 ? (
                  <CommunitySelect
                    label={t('Interface')}
                    value={chosen.id}
                    options={slot.backends.map(backend => ({ id: backend.id, label: backend.label[locale] }))}
                    disabled={loading || busy}
                    onChange={id => setChosenBackends(current => ({ ...current, [slot.id]: id }))}
                  />
                ) : null}
                {backendForm(slot.id, chosen)}
              </>
            ) : (
              slot.backends.map(backend => backendForm(slot.id, backend))
            )}
          </section>
        )
      })}
      {kind === 'plugin' ? <CommunityPluginUpstreams packageName={name} mode="catalog" embedded onChanged={onChanged} /> : null}
      {view?.retainedLegacyFields?.length ? (
        <section className="page-stack">
          <h3>{t('Retained credentials from a previous version')}</h3>
          <ul className="grant-rows">
            {view.retainedLegacyFields.map(field => (
              <li key={field}>
                <span>{field}</span>
                <Button
                  size="sm"
                  variant="tertiary"
                  isDisabled={busy || loading || dirty}
                  onPress={() => setConfirmation({ field, action: 'discard-legacy', confirmed: true })}
                >
                  {t('Discard retained credential')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {confirmation ? (
        <CommunityDialog
          title={confirmationTitle}
          busy={busy}
          onClose={() => setConfirmation(undefined)}
          footer={
            <>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setConfirmation(undefined)}>
                {t('Cancel')}
              </Button>
              <Button variant={confirmation.action === 'adopt-legacy' ? 'primary' : 'danger'} isDisabled={busy} onPress={() => void change(confirmation)}>
                {confirmationTitle}
              </Button>
            </>
          }
        >
          <p>
            {t(
              confirmation.action === 'adopt-legacy'
                ? 'Use retained {field} for this backend?'
                : confirmation.action === 'discard-legacy'
                  ? 'Discard retained {field}?'
                  : 'Clear {field} and disable this backend?',
              { field: confirmation.field },
            )}
          </p>
        </CommunityDialog>
      ) : null}
    </section>
  )
}
