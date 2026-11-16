import { useEffect, useState } from 'react'
import { Button } from '@heroui/react/button'
import { ProgressBar } from '@heroui/react/progress-bar'
import { Switch } from '@heroui/react/switch'
import type { PlatformVoicePrecision, PlatformVoiceSettingsView } from '../../src/domain/admin-contract'
import { platformVoiceSettings, savePlatformVoiceSettings } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityMessage from './CommunityMessage'

const status = { off: 'Voice input off', preparing: 'Preparing voice models', ready: 'Voice input ready', failed: 'Voice preparation failed' } as const
const failures = {
  download: 'Could not download the voice model files.',
  integrity: 'The model files did not match the expected checksum or size.',
  storage: 'Could not store the voice model files.',
} as const

export default function CommunityPlatformVoiceSettings() {
  const { t, errorText } = usePlatformLanguage()
  const [saved, setSaved] = useState<PlatformVoiceSettingsView>()
  const [precision, setPrecision] = useState<PlatformVoicePrecision>('int8')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      try {
        const view = await platformVoiceSettings(controller.signal)
        if (controller.signal.aborted) return
        setSaved(view)
        setPrecision(view.precision)
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure)
      }
    }
    void load()
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (saved?.status !== 'preparing') return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const view = await platformVoiceSettings(controller.signal)
        if (!controller.signal.aborted) setSaved(current => (current && view.revision >= current.revision ? view : current))
      } catch {
        // Keep the last successful status until the same API can be read again.
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1250)
    }
    timer = setTimeout(() => void poll(), 1250)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [saved?.status])

  const apply = async (enabled: boolean, selected: PlatformVoicePrecision) => {
    if (!saved || busy) return
    setBusy(true)
    setError(undefined)
    try {
      setSaved(await savePlatformVoiceSettings({ enabled, precision: selected, revision: saved.revision }))
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel settings-panel" aria-label={t('Platform voice input')}>
      <div className="panel-top">
        <h2>{t('Platform voice input')}</h2>
      </div>
      <div className="settings-panel-body">
        {error !== undefined && <CommunityMessage role="alert" status="danger" title={errorText(error)} />}
        {saved && (
          <div className="platform-feature-form">
            <Switch isSelected={saved.enabled} isDisabled={busy} onChange={enabled => void apply(enabled, precision)}>
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                {t('Enable voice input')}
              </Switch.Content>
            </Switch>
            <p role="status">{t(status[saved.status])}</p>
            {saved.progress && (
              <ProgressBar aria-label={t('Preparing voice models')} value={saved.progress.received} maxValue={saved.progress.total} size="sm">
                <ProgressBar.Track>
                  <ProgressBar.Fill />
                </ProgressBar.Track>
              </ProgressBar>
            )}
            {saved.activePrecision && saved.activePrecision !== saved.precision && saved.enabled && (
              <p>{t('The active model stays available while the new model is prepared.')}</p>
            )}
            {saved.failure && <p>{t(failures[saved.failure])}</p>}
            <fieldset className="platform-feature-choices" disabled={busy}>
              <legend>{t('Voice model precision')}</legend>
              <label>
                <input type="radio" name="voice-precision" checked={precision === 'int8'} onChange={() => setPrecision('int8')} />{' '}
                {t('Standard (INT8, about 239 MB)')}
              </label>
              <label>
                <input type="radio" name="voice-precision" checked={precision === 'fp32'} onChange={() => setPrecision('fp32')} />{' '}
                {t('High precision (FP32, about 938 MB)')}
              </label>
            </fieldset>
            {precision === 'fp32' && <p>{t('High precision uses more memory in each member instance.')}</p>}
            <p>{t('Members get this voice setting the next time they start their instance.')}</p>
            {!window.isSecureContext && <p>{t('Members need HTTPS to use the microphone.')}</p>}
            {(precision !== saved.precision || saved.status === 'failed') && (
              <div className="settings-panel-actions">
                <Button variant="primary" isDisabled={busy} onPress={() => void apply(saved.enabled, precision)}>
                  {t(precision !== saved.precision ? 'Save changes' : 'Retry preparation')}
                </Button>
              </div>
            )}
          </div>
        )}
        {!saved && error === undefined && <p role="status">{t('Loading…')}</p>}
      </div>
    </section>
  )
}
