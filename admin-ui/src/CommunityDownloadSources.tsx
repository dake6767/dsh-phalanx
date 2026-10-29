import { useEffect, useState } from 'react'
import { Button } from '@heroui/react/button'
import type { CommunityDownloadSourcesView } from '../../src/domain/admin-contract'
import type { DownloadSourceCategory, DownloadSourcePreset, DownloadSourceValues } from '../../src/domain/download-source'
import { communityDownloadSources, saveCommunityDownloadSources } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunitySelect from './CommunitySelect'
import CommunityField from './CommunityField'
import CommunityMessage from './CommunityMessage'

const fields = [
  ['npm', 'npm registry'],
  ['pypi', 'PyPI index'],
  ['containerMirror', 'Docker Hub mirror'],
  ['ghcrMirror', 'GHCR mirror'],
  ['githubAssets', 'GitHub asset prefix'],
  ['browser', 'Browser downloads'],
  ['browserChromiumArm64', 'Browser arm64 downloads'],
] as const
export default function CommunityDownloadSources() {
  const { t, errorText } = usePlatformLanguage()
  const [saved, setSaved] = useState<CommunityDownloadSourcesView>()
  const [preset, setPreset] = useState<DownloadSourcePreset>('official')
  const [draft, setDraft] = useState<DownloadSourceValues>()
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(false),
    [error, setError] = useState<unknown>()
  useEffect(() => {
    const controller = new AbortController()
    void communityDownloadSources(controller.signal)
      .then(value => {
        setSaved(value)
        setPreset(value.preset)
        setDraft(value.sources)
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    return () => controller.abort()
  }, [])
  const save = async () => {
    if (!draft || !saved) return
    setBusy(true)
    setError(undefined)
    setNotice(false)
    const overrides = Object.fromEntries(fields.filter(([key]) => draft[key] !== saved.presets[preset][key]).map(([key]) => [key, draft[key]]))
    try {
      const value = await saveCommunityDownloadSources({ preset, overrides })
      setSaved(value)
      setDraft(value.sources)
      setNotice(true)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  const edit = (key: DownloadSourceCategory, value: string) => {
    setNotice(false)
    setDraft(current => (current ? { ...current, [key]: value } : current))
  }
  return (
    <section className="panel settings-panel" aria-label={t('Download sources')}>
      <div className="panel-top">
        <div>
          <h2>{t('Download sources')}</h2>
          <p>{t('Choose a preset, then edit individual addresses. New preparations and future update downloads use the saved choices.')}</p>
        </div>
      </div>
      <div className="settings-panel-body">
        {error !== undefined && (
          <CommunityMessage
            role="alert"
            status="danger"
            title={errorText(error, saved ? 'Unable to save download sources' : 'Unable to load download sources')}
          />
        )}
        {notice && <CommunityMessage role="status" status="success" title={t('Download sources saved.')} />}
        {!draft || !saved ? (
          <p role="status">{t('Loading…')}</p>
        ) : (
          <form
            onSubmit={event => {
              event.preventDefault()
              void save()
            }}
          >
            <CommunitySelect
              label={t('Download preset')}
              value={preset}
              disabled={busy}
              options={[
                { id: 'official', label: t('Official') },
                { id: 'mainland', label: t('Mainland China') },
              ]}
              onChange={value => {
                const choice = value as DownloadSourcePreset
                setPreset(choice)
                setDraft(saved.presets[choice])
                setNotice(false)
              }}
            />
            {fields.map(([key, label]) => (
              <CommunityField key={key} label={t(label)} value={draft[key]} type="url" disabled={busy} onChange={value => edit(key, value)} />
            ))}
            <p className="muted">{t('Leave mirror and prefix fields empty for direct official downloads.')}</p>
            {preset === 'mainland' && (
              <p className="muted">
                {t('The mainland browser mirror currently lacks the arm64 browser. Its separate address uses the official download host.')}
              </p>
            )}
            <Button type="submit" isPending={busy} isDisabled={busy}>
              {t('Save download sources')}
            </Button>
          </form>
        )}
      </div>
    </section>
  )
}
