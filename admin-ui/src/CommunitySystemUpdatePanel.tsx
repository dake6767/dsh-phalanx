import { Card } from '@heroui/react/card'
import SystemUpdateCheck from './CommunitySystemUpdateCheck'
import { UpdateFailure } from './CommunitySystemUpdateDetails'
import SystemUpdateOperation from './CommunitySystemUpdateOperation'
import CommunityInstanceResourceSettings from './CommunityInstanceResourceSettings'
import CommunityUsageSettings from './CommunityUsageSettings'
import CommunityDownloadSources from './CommunityDownloadSources'
import CommunityExecutionSettings from './CommunityExecutionSettings'
import { usePlatformLanguage } from './CommunityLanguage'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import CommunitySystemUpdateConfirmation from './CommunitySystemUpdateConfirmation'
import type {
  CommunitySystemUpdateAction,
  CommunitySystemUpdateCheck,
  CommunitySystemUpdateOperation,
  CommunitySystemUpdateStatus,
} from '../../src/domain/admin-contract'
import { CommunityApiRequestError, communitySystemUpdate, executeCommunitySystemUpdate } from './community-api'
import CommunityMessage from './CommunityMessage'

const operationKey = 'dsh-phalanx-system-update'
const active = new Set([
  'preparing',
  'stopping',
  'backing-up',
  'backed-up',
  'switching',
  'validating',
  'committed',
  'restoring',
  'restoration-committed',
  'recovery-failed',
])
function readOperation(): string | undefined {
  try {
    const value = localStorage.getItem(operationKey)
    return value && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value) ? value : undefined
  } catch {
    return undefined
  }
}
function storeOperation(id?: string) {
  try {
    if (id) localStorage.setItem(operationKey, id)
    else localStorage.removeItem(operationKey)
  } catch {
    /* Status still follows the root owner's latest operation. */
  }
}

export default function CommunitySystemUpdatePanel() {
  const { t, errorText } = usePlatformLanguage()
  const [snapshot, setSnapshot] = useState<CommunitySystemUpdateStatus>()
  const [check, setCheck] = useState<CommunitySystemUpdateCheck>()
  const [preferCheck, setPreferCheck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [error, setError] = useState<unknown>()
  const [transportError, setTransportError] = useState<unknown>()
  const [statusError, setStatusError] = useState<CommunityApiRequestError>()
  const operationId = useRef(readOperation())
  const autoChecked = useRef(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const submitting = useRef(false)
  const remember = (operation: CommunitySystemUpdateOperation | null) => {
    const id =
      operation && (active.has(operation.phase) || operation.phase === 'prepared' || operation.cleanup?.status === 'running') ? operation.id : undefined
    operationId.current = id
    storeOperation(id)
  }
  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const observedGeneration = generation.current
      try {
        const value = await communitySystemUpdate(operationId.current, controller.signal)
        if (controller.signal.aborted) return
        if (!submitting.current && observedGeneration === generation.current) {
          remember(value.operation)
          if (value.operation && (active.has(value.operation.phase) || value.operation.phase === 'prepared' || value.operation.cleanup?.status === 'running'))
            setPreferCheck(false)
          setSnapshot(value)
          setReconnecting(false)
          setTransportError(undefined)
          setStatusError(undefined)
          if (!autoChecked.current) {
            autoChecked.current = true
            if (
              !value.operation ||
              (!active.has(value.operation.phase) && value.operation.phase !== 'prepared' && value.operation.cleanup?.status !== 'running')
            )
              void submit({ action: 'check' }, true)
          }
        }
      } catch (failure) {
        if (!controller.signal.aborted && !submitting.current && observedGeneration === generation.current) {
          if (failure instanceof CommunityApiRequestError && failure.status !== 503) {
            setReconnecting(false)
            setStatusError(failure)
            setSnapshot(undefined)
            setCheck(undefined)
            setConfirm(false)
          } else setReconnecting(true)
        }
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => {
          void poll()
        }, 2000)
    }
    void poll()
    return () => {
      mounted.current = false
      controller.abort()
      clearTimeout(timer)
    }
  }, [])
  const submit = async (input: CommunitySystemUpdateAction, automatic = false) => {
    if (submitting.current || reconnecting || statusError) return
    if (input.action === 'check') autoChecked.current = true
    setPreferCheck(input.action === 'check' && !automatic)
    submitting.current = true
    generation.current++
    setBusy(true)
    setError(undefined)
    setTransportError(undefined)
    if (input.action === 'apply') {
      operationId.current = input.operation
      storeOperation(input.operation)
      setConfirm(false)
      setReconnecting(true)
    }
    try {
      const value = await executeCommunitySystemUpdate(input)
      if (!mounted.current) return
      if ('check' in value) {
        setCheck(value.check)
        setSnapshot(value)
        remember(value.operation)
      } else {
        remember(value.operation)
        setSnapshot(previous => ({
          currentVersion: previous?.currentVersion ?? null,
          runningVersion: previous?.runningVersion ?? null,
          events: [],
          ...(previous?.previousDowntimeSeconds !== undefined ? { previousDowntimeSeconds: previous.previousDowntimeSeconds } : {}),
          operation: value.operation,
        }))
      }
    } catch (failure) {
      if (!mounted.current) return
      if (input.action === 'check') setCheck({ status: 'failed', checkedAt: new Date().toISOString(), reason: '' })
      if (input.action !== 'check') setReconnecting(failure instanceof TypeError || (failure instanceof CommunityApiRequestError && failure.status === 503))
      const message = failure
      if (failure instanceof TypeError || (failure instanceof CommunityApiRequestError && failure.status === 503)) setTransportError(message)
      else setError(message)
    } finally {
      submitting.current = false
      generation.current++
      if (mounted.current) setBusy(false)
    }
  }
  const operation = snapshot?.operation
  const changing = operation && (active.has(operation.phase) || operation.cleanup?.status === 'running')
  const showOperation = Boolean(operation && (changing || operation.phase === 'prepared' || !preferCheck))
  return (
    <div className="system-settings-stack">
      <section className="page-heading">
        <div>
          <h1>{t('System settings')}</h1>
          <p>{t('Manage the installed version and recoverable system updates.')}</p>
        </div>
      </section>
      <Card id="system-update" className="system-update" role="region" aria-label={t('System update')}>
        <Card.Header>
          <Card.Title>{t('System update')}</Card.Title>
          <Card.Description>{t('Check manually for compatible formal releases. Downloading leaves the current service running.')}</Card.Description>
          <Button
            variant="secondary"
            isDisabled={busy || reconnecting || Boolean(statusError) || Boolean(changing)}
            onPress={() => {
              void submit({ action: 'check' })
            }}
          >
            {t('Check for updates')}
          </Button>
        </Card.Header>
        <Card.Content className="settings-panel-body">
          <div className="update-versions">
            <p>{t('Installed version: {version}', { version: snapshot?.currentVersion ?? t('Unknown') })}</p>
            <p>{t('Running version: {version}', { version: reconnecting ? t('Unknown while reconnecting.') : (snapshot?.runningVersion ?? t('Unknown')) })}</p>
          </div>
          {reconnecting && snapshot?.runningVersion && <p>{t('Last verified running version: {version}', { version: snapshot.runningVersion })}</p>}
          {check && !showOperation && (
            <SystemUpdateCheck
              check={check}
              disabled={busy || reconnecting || Boolean(statusError) || Boolean(changing)}
              prepare={(version, manifestSha256) => {
                void submit({ action: 'prepare', version, manifestSha256 })
              }}
            />
          )}
          {reconnecting && <p role="status">{t('Reconnecting to the original update. Refreshing or closing this page does not cancel an accepted update.')}</p>}
          {reconnecting && (
            <p>
              {t('The update result is unknown until the service responds. If it remains unavailable, follow the ')}
              <a href="https://github.com/dake6767/dsh-phalanx/blob/main/docs/install.md#recoverable-system-updates" target="_blank" rel="noreferrer">
                {t('server recovery instructions')}
              </a>
              .
            </p>
          )}
          {transportError !== undefined && <CommunityMessage role="alert" status="danger" title={errorText(transportError, 'System update request failed')} />}
          {statusError && (
            <CommunityMessage role="alert" status="danger" title={errorText(statusError)}>
              {statusError.status === 403 && <a href="/">{t('Return to DSH')}</a>}
              {statusError.status === 404 && (
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => {
                    operationId.current = undefined
                    storeOperation()
                    setStatusError(undefined)
                  }}
                >
                  {t('Stop following unavailable operation')}
                </Button>
              )}
            </CommunityMessage>
          )}
          {error !== undefined &&
            (error instanceof CommunityApiRequestError && typeof error.params?.systemUpdateErrorCode === 'string' ? (
              <UpdateFailure code={error.params.systemUpdateErrorCode} raw={error.message} log={snapshot?.operation?.diagnosticLog} />
            ) : (
              <CommunityMessage role="alert" status="danger" title={errorText(error)} />
            ))}
          {operation && showOperation && (
            <SystemUpdateOperation
              operation={operation}
              events={snapshot?.events ?? []}
              reconnecting={reconnecting}
              disabled={busy || reconnecting || Boolean(statusError) || Boolean(changing)}
              retryCleanup={() => {
                void submit({ action: 'cleanup', operation: operation.id })
              }}
              retryUpdate={() => {
                void submit({ action: 'check' })
              }}
            >
              {operation.phase === 'prepared' && (
                <Button isDisabled={busy || reconnecting || Boolean(statusError) || Boolean(changing)} onPress={() => setConfirm(true)}>
                  {t('Apply update')}
                </Button>
              )}
            </SystemUpdateOperation>
          )}
          {confirm && operation?.phase === 'prepared' && (
            <CommunitySystemUpdateConfirmation
              operation={operation}
              previousDowntimeSeconds={snapshot?.previousDowntimeSeconds ?? operation.previousDowntimeSeconds}
              disabled={busy || reconnecting || Boolean(statusError) || Boolean(changing)}
              onCancel={() => setConfirm(false)}
              onConfirm={() => {
                void submit({ action: 'apply', operation: operation.id, confirmed: true })
              }}
            />
          )}
        </Card.Content>
      </Card>
      <CommunityDownloadSources />
      <CommunityUsageSettings />
      <CommunityInstanceResourceSettings />
      <CommunityExecutionSettings />
    </div>
  )
}
