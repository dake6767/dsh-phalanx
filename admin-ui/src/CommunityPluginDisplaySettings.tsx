import { useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Label } from '@heroui/react/label'
import { TextArea } from '@heroui/react/textarea'
import { TextField } from '@heroui/react/textfield'
import type { CommunityPluginDisplayInput, CommunityPluginView } from '../../src/domain/admin-contract'
import { resolvePluginDisplay, type PluginDisplayOverride } from '../../src/domain/plugin-display'
import { request } from './community-api'
import CommunityField from './CommunityField'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityMessage from './CommunityMessage'
import { useDraftGuard } from './useDraftGuard'

const overrides = (plugin: CommunityPluginView) => ({ name: plugin.display?.name ?? '', description: plugin.display?.description ?? '' })

export default function CommunityPluginDisplaySettings({
  plugin,
  onChanged,
  onCloseGuard,
  onSaveFailed,
}: {
  plugin: CommunityPluginView
  onChanged: () => void
  onCloseGuard: (guard: ((action: () => void) => void) | undefined) => void
  onSaveFailed: () => void
}) {
  const { t, locale, errorText } = usePlatformLanguage()
  const [saved, setSaved] = useState(() => overrides(plugin))
  const [draft, setDraft] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const [updated, setUpdated] = useState(false)
  const pending = useRef(false)
  const dirty = draft.name !== saved.name || draft.description !== saved.description
  const catalogDefaults = plugin.display?.catalogDefaults
  const defaults = resolvePluginDisplay({ ...plugin, display: catalogDefaults ? { catalogDefaults } : {} }, locale)
  const persist = async (display: PluginDisplayOverride) => {
    if (pending.current) return false
    pending.current = true
    setBusy(true)
    setError(undefined)
    setUpdated(false)
    try {
      const input: CommunityPluginDisplayInput = { packageName: plugin.packageName, display }
      const result = overrides(
        await request<CommunityPluginView>('/admin/api/plugins/display', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )
      setSaved(result)
      setDraft(result)
      setUpdated(true)
      onChanged()
      return true
    } catch (failure) {
      setError(failure)
      onSaveFailed()
      return false
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const save = () =>
    persist({
      ...(draft.name !== saved.name ? { name: draft.name } : {}),
      ...(draft.description !== saved.description ? { description: draft.description } : {}),
    })
  const guard = useDraftGuard(dirty, save, () => setDraft(saved), busy)
  useEffect(() => {
    onCloseGuard(guard.request)
    return () => onCloseGuard(undefined)
  }, [guard.request, onCloseGuard])
  return (
    <section className="plugin-detail-section" aria-label={t('Display information')}>
      <h2>{t('Display information')}</h2>
      <CommunityField
        label={t('Display name')}
        value={draft.name}
        placeholder={defaults.title}
        onChange={name => setDraft({ ...draft, name })}
        disabled={busy}
      />
      <TextField
        className="platform-field"
        variant="primary"
        value={draft.description}
        onChange={description => setDraft({ ...draft, description })}
        isDisabled={busy}
      >
        <Label>{t('Function description')}</Label>
        <TextArea rows={3} placeholder={defaults.description} />
      </TextField>
      {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
      {updated && !dirty ? <CommunityMessage role="status" status="success" title={t('Plugin display information saved.')} /> : null}
      <div className="plugin-settings-actions settings-panel-actions">
        <Button size="sm" isDisabled={busy || !dirty} onPress={() => void save()}>
          {t('Save display information')}
        </Button>
        <Button
          size="sm"
          variant="tertiary"
          isDisabled={busy || !(dirty || saved.name || saved.description)}
          onPress={() => void persist({ name: '', description: '' })}
        >
          {t('Restore defaults')}
        </Button>
      </div>
      {guard.dialog}
    </section>
  )
}
