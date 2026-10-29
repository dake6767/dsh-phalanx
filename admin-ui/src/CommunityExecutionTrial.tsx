import { useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import type { CommunityExecutionTrial } from '../../src/domain/admin-contract'
import { executionSettings, tryExecution } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityField from './CommunityField'
import CommunityMessage from './CommunityMessage'

export default function CommunityExecutionTrialPanel({ name, disabled }: { name: string; disabled: boolean }) {
  const { t, errorText } = usePlatformLanguage()
  const [line, setLine] = useState(''),
    [result, setResult] = useState<CommunityExecutionTrial>(),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [isolated, setIsolated] = useState(true)
  const current = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    void executionSettings(controller.signal)
      .then(value => {
        if (!controller.signal.aborted) setIsolated(value.isolated)
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    return () => {
      controller.abort()
      current.current?.abort()
    }
  }, [])
  const run = async () => {
    if (busy || disabled || !line.trim()) return
    const controller = new AbortController()
    current.current = controller
    setBusy(true)
    setError(undefined)
    setResult(undefined)
    try {
      const value = await tryExecution('skill:' + name, line, controller.signal)
      if (!controller.signal.aborted) setResult(value)
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return (
    <section className="plugin-access-template" aria-label={t('Try execution')}>
      <h4>{t('Try execution')}</h4>
      <p>{t('Run as yourself in your own workspace. Save configuration changes first. Arguments are literal; shell operators are not expanded.')}</p>
      {!isolated ? <CommunityMessage status="warning" title={t('Platform execution is not isolated. Development only.')} /> : null}
      <CommunityField label={t('Command line')} value={line} onChange={setLine} disabled={busy} />
      <div>
        <Button
          variant="secondary"
          isDisabled={disabled || busy || !line.trim()}
          onPress={() => {
            void run()
          }}
        >
          {t('Run command')}
        </Button>
      </div>
      {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
      {result ? (
        <div role="status">
          <p>{t('Exit code: {code}', { code: result.exitCode })}</p>
          <h4>stdout</h4>
          <pre className="plugin-preparation-log">{result.stdout || '—'}</pre>
          <h4>stderr</h4>
          <pre className="plugin-preparation-log">{result.stderr || '—'}</pre>
          {result.truncated ? <p>{t('Output truncated at 256 KiB.')}</p> : null}
        </div>
      ) : null}
    </section>
  )
}
