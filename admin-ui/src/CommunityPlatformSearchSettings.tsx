import { useEffect, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Switch } from '@heroui/react/switch'
import type { PlatformSearchSettingsChange, PlatformSearchSettingsView } from '../../src/domain/admin-contract'
import { platformSearchSettings, savePlatformSearchSettings } from './community-api'
import CommunityDialog from './CommunityDialog'
import CommunityField from './CommunityField'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityMessage from './CommunityMessage'

export default function CommunityPlatformSearchSettings() {
  const { t, errorText } = usePlatformLanguage()
  const [saved, setSaved] = useState<PlatformSearchSettingsView>()
  const [enabled, setEnabled] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [error, setError] = useState<unknown>()
  const [notice, setNotice] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void platformSearchSettings(controller.signal)
      .then(value => {
        setSaved(value)
        setEnabled(value.enabled)
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    return () => controller.abort()
  }, [])

  const save = async (change: PlatformSearchSettingsChange) => {
    setBusy(true)
    setError(undefined)
    setNotice(false)
    try {
      const value = await savePlatformSearchSettings(change)
      setSaved(value)
      setEnabled(value.enabled)
      setKey('')
      setNotice(true)
    } catch (failure) {
      setError(failure)
    } finally {
      setConfirmClear(false)
      setBusy(false)
    }
  }
  const missingKey = enabled && !saved?.hasKey && !key.trim()

  return (
    <section className="panel settings-panel" aria-label={t('Platform web search')}>
      <div className="panel-top">
        <h2>{t('Platform web search')}</h2>
      </div>
      <div className="settings-panel-body">
        {error !== undefined && <CommunityMessage role="alert" status="danger" title={errorText(error)} />}
        {notice && <CommunityMessage role="status" status="success" title={t('Platform search settings saved.')} />}
        {saved ? (
          <form
            className="platform-feature-form"
            onSubmit={event => {
              event.preventDefault()
              if (missingKey || busy) return
              const apiKey = enabled ? key.trim() : ''
              void save({ action: 'save', revision: saved.revision, enabled, ...(apiKey ? { apiKey } : {}) })
            }}
          >
            <Switch
              isSelected={enabled}
              isDisabled={busy}
              onChange={value => {
                setEnabled(value)
                if (!value) setKey('')
                setNotice(false)
              }}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                {t('Enable platform web search')}
              </Switch.Content>
            </Switch>
            <p role="status">{t(saved.enabled ? 'Search configured' : saved.hasKey ? 'Search off · key saved' : 'Search off')}</p>
            {enabled && (
              <CommunityField
                label={t('DeepSeek Search API key')}
                type="password"
                autoComplete="new-password"
                value={key}
                onChange={value => {
                  setKey(value)
                  setNotice(false)
                }}
                disabled={busy}
                required={!saved.hasKey}
                placeholder={saved.hasKey ? t('Leave blank to keep the saved key') : undefined}
              />
            )}
            <p>{t('Members get this search setting the next time they start their instance.')}</p>
            <div className="settings-panel-actions">
              <Button type="submit" variant="primary" isDisabled={busy || missingKey || (enabled === saved.enabled && !key.trim())}>
                {t('Save changes')}
              </Button>
              {saved.hasKey && (
                <Button type="button" variant="tertiary" isDisabled={busy} onPress={() => setConfirmClear(true)}>
                  {t('Clear search key')}
                </Button>
              )}
            </div>
          </form>
        ) : error === undefined ? (
          <p role="status">{t('Loading…')}</p>
        ) : null}
      </div>
      {confirmClear && saved && (
        <CommunityDialog
          title={t('Clear search key?')}
          busy={busy}
          onClose={() => setConfirmClear(false)}
          footer={
            <>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setConfirmClear(false)}>
                {t('Cancel')}
              </Button>
              <Button variant="danger" isDisabled={busy} onPress={() => void save({ action: 'clear', revision: saved.revision })}>
                {t('Clear search key')}
              </Button>
            </>
          }
        >
          <p>{t('Clearing the key turns off platform web search.')}</p>
        </CommunityDialog>
      )}
    </section>
  )
}
