import { useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import type { CommunitySystemStatusView } from '../../src/domain/admin-contract'
import { communitySystemStatus, confirmCommunityMasterKeyBackup } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityMessage from './CommunityMessage'

export default function CommunitySystemStatusPanel() {
  const { t, errorText, locale } = usePlatformLanguage()
  const [snapshot, setSnapshot] = useState<CommunitySystemStatusView>()
  const [error, setError] = useState<unknown>()
  const [pending, setPending] = useState(false)
  const generation = useRef(0)
  const busy = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      if (!busy.current) {
        const current = ++generation.current
        try {
          const next = await communitySystemStatus(controller.signal)
          if (!controller.signal.aborted && current === generation.current) {
            setSnapshot(next)
            setError(undefined)
          }
        } catch (failure) {
          if (!controller.signal.aborted && current === generation.current) {
            setSnapshot(undefined)
            setError(failure)
          }
        }
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => {
          void load()
        }, 5000)
    }
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
      ++generation.current
    }
  }, [])
  const confirm = async () => {
    if (!snapshot || busy.current) return
    busy.current = true
    setPending(true)
    const current = ++generation.current
    try {
      const next = await confirmCommunityMasterKeyBackup(snapshot.masterKey.fingerprint)
      if (current === generation.current) {
        setSnapshot(next)
        setError(undefined)
      }
    } catch (failure) {
      if (current === generation.current) {
        setSnapshot(undefined)
        setError(failure)
      }
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  const backup = snapshot?.masterKey.backup
  return (
    <section className="panel settings-panel" aria-label={t('Platform database and master key')}>
      <div className="panel-top">
        <div>
          <h2>{t('Platform database and master key')}</h2>
          <p>{t('Keep an offline copy of the master key in a secure location.')}</p>
        </div>
      </div>
      <div className="settings-panel-body" aria-live="polite">
        {error !== undefined && <CommunityMessage role="alert" status="danger" title={errorText(error)} />}
        {!snapshot && error === undefined && <p role="status">{t('Loading…')}</p>}
        {snapshot && (
          <>
            <dl className="system-status-facts">
              <div>
                <dt>{t('Platform database')}</dt>
                <dd>{t(snapshot.database.kind === 'builtin' ? 'Built-in PostgreSQL' : 'External PostgreSQL')}</dd>
              </div>
              <div>
                <dt>{t('Database address')}</dt>
                <dd>{snapshot.database.address}</dd>
              </div>
              <div>
                <dt>{t('Database version')}</dt>
                <dd>{snapshot.database.serverVersion}</dd>
              </div>
              <div>
                <dt>{t('Connection status')}</dt>
                <dd>{t('Connected')}</dd>
              </div>
              <div>
                <dt>{t('Master-key fingerprint')}</dt>
                <dd>
                  <code>{snapshot.masterKey.fingerprint}</code>
                </dd>
              </div>
            </dl>
            {backup ? (
              <p>
                <span>{t('Confirmed by {username}', { username: backup.username })}</span> ·{' '}
                <time dateTime={backup.confirmedAt}>{new Date(backup.confirmedAt).toLocaleString(locale)}</time>
              </p>
            ) : (
              <>
                <p>{t('Offline backup not confirmed')}</p>
                <Button
                  variant="secondary"
                  isDisabled={pending}
                  isPending={pending}
                  onPress={() => {
                    void confirm()
                  }}
                >
                  {t('I have backed up the master key offline')}
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </section>
  )
}
