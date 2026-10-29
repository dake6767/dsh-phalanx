import { useEffect, useState } from 'react'
import { Button } from '@heroui/react/button'
import { saveUsageRetention, usageSettings } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityField from './CommunityField'
import CommunityMessage from './CommunityMessage'

export default function CommunityUsageSettings() {
  const { t, errorText } = usePlatformLanguage()
  const [days, setDays] = useState(''),
    [saved, setSaved] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>()
  useEffect(() => {
    const controller = new AbortController()
    void usageSettings(controller.signal)
      .then(value => {
        if (!controller.signal.aborted) {
          setDays(String(value.retentionDays))
          setSaved(String(value.retentionDays))
        }
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    return () => controller.abort()
  }, [])
  const save = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const value = await saveUsageRetention(Number(days))
      setDays(String(value.retentionDays))
      setSaved(String(value.retentionDays))
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="panel" aria-label={t('Usage record retention')}>
      <div className="panel-top">
        <h2>{t('Usage record retention')}</h2>
        <p>{t('Expired usage records are removed automatically. The default is 180 days.')}</p>
      </div>
      {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
      <form
        className="plugin-environment-row"
        onSubmit={event => {
          event.preventDefault()
          void save()
        }}
      >
        <CommunityField
          label={t('Retention days')}
          value={days}
          onChange={setDays}
          required
          pattern="[0-9]+"
          disabled={busy || !saved}
          description={t('Choose 1 to 3650 days. Shortening retention removes older records.')}
          variant="secondary"
        />
        <Button type="submit" isDisabled={busy || !saved || days === saved} isPending={busy}>
          {t('Save changes')}
        </Button>
      </form>
    </section>
  )
}
