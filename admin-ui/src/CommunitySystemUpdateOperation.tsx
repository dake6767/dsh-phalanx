import type { ReactNode } from 'react'
import { Button } from '@heroui/react/button'
import { Link } from '@heroui/react/link'
import { ProgressBar } from '@heroui/react/progress-bar'
import type { CommunitySystemUpdateEvent, CommunitySystemUpdateOperation } from '../../src/domain/admin-contract'
import { systemUpdateCodes, systemUpdateText } from '../../src/domain/system-update-codes'
import { en as updateMessages } from '../../src/domain/model-update-messages'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityMessage from './CommunityMessage'
import { CleanupFacts, DiskFacts, UpdateDisclosure, UpdateFailure, updateSize } from './CommunitySystemUpdateDetails'

function DownloadProgress({ events, reconnecting }: { events: readonly CommunitySystemUpdateEvent[]; reconnecting: boolean }) {
  const { t, locale } = usePlatformLanguage()
  let event: CommunitySystemUpdateEvent | undefined
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]!.status !== 'detail' && events[index]!.action) {
      event = events[index]
      break
    }
  }
  const knownTotal = event?.total !== undefined && event.total > 0 && event.bytes !== undefined && event.bytes <= event.total
  const percent = knownTotal ? Math.round((event!.bytes! / event!.total!) * 100) : undefined
  const action = event?.action
  return (
    <div className="update-progress">
      {reconnecting && <p>{t('Last reported progress')}</p>}
      {action && (
        <p>
          {Object.hasOwn(updateMessages, action)
            ? t(action as keyof typeof updateMessages)
            : locale === 'en'
              ? action
              : t('See update diagnostics for the current step.')}
        </p>
      )}
      <ProgressBar aria-label={t('Download progress')} value={percent ?? 0} isIndeterminate={percent === undefined} size="sm">
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>
      {percent !== undefined ? (
        <p>
          {percent}% · {updateSize(event!.bytes!, locale)} / {updateSize(event!.total!, locale)}
        </p>
      ) : (
        event?.bytes !== undefined && <p>{t('{size} received', { size: updateSize(event.bytes, locale) })}</p>
      )}
      {(event?.phaseElapsed !== undefined || event?.elapsed !== undefined) && (
        <p className="muted">
          {[
            event.phaseElapsed !== undefined && t('Phase elapsed: {seconds}s', { seconds: Math.round(event.phaseElapsed) }),
            event.elapsed !== undefined && t('Total elapsed: {seconds}s', { seconds: Math.round(event.elapsed) }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </div>
  )
}

export default function SystemUpdateOperation({
  operation,
  events,
  reconnecting,
  disabled,
  retryCleanup,
  retryUpdate,
  children,
}: {
  operation: CommunitySystemUpdateOperation
  events: readonly CommunitySystemUpdateEvent[]
  reconnecting: boolean
  disabled: boolean
  retryCleanup: () => void
  retryUpdate: () => void
  children: ReactNode
}) {
  const { t, locale } = usePlatformLanguage()
  const code = operation.phaseCode ?? `update.${operation.phase}`
  const phase = systemUpdateText(code, locale) ?? t('See update diagnostics for the current step.')
  const metadata = (systemUpdateCodes.phases as Readonly<Record<string, { step?: number; total?: number }>>)[code]
  const timing = operation.timing
  const finished = ['succeeded', 'restored', 'apply-failed', 'prepare-failed', 'recovery-failed'].includes(operation.phase)
  return (
    <div aria-live="polite">
      <div className="update-stage">
        <h3>{metadata?.step ? t('Step {step}/{total} · {phase}', { step: metadata.step, total: metadata.total!, phase }) : phase}</h3>
        <p>{t('Latest operation: {version}', { version: operation.targetVersion })}</p>
      </div>
      {metadata?.step && (
        <ProgressBar aria-label={t('Upgrade progress')} value={metadata.step} maxValue={metadata.total} size="sm">
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
      )}
      {operation.phase === 'preparing' && <DownloadProgress events={events} reconnecting={reconnecting} />}
      {timing?.downtimeSeconds !== undefined && (
        <p>{t(timing.downtimeActive ? 'Downtime so far: {seconds}s' : 'Total downtime: {seconds}s', { seconds: Math.round(timing.downtimeSeconds) })}</p>
      )}
      {timing && !finished && <p>{t('Phase elapsed: {seconds}s', { seconds: Math.round(timing.phaseElapsedSeconds) })}</p>}
      {timing && finished && (
        <ul aria-label={t('Phase durations')}>
          {Object.entries(timing.phaseSeconds).map(([name, seconds]) => (
            <li key={name}>{t('{phase}: {seconds}s', { phase: systemUpdateText(`update.${name}`, locale) ?? name, seconds: Math.round(seconds) })}</li>
          ))}
        </ul>
      )}
      {operation.failure && <UpdateFailure code={operation.errorCode} raw={operation.failure} log={operation.diagnosticLog} />}
      {operation.stopFailure && (
        <UpdateFailure label="Stop failure: {error}" code={operation.stopErrorCode} raw={operation.stopFailure} log={operation.diagnosticLog} />
      )}
      {operation.recoveryFailure && (
        <UpdateFailure label="Recovery failure: {error}" code={operation.recoveryErrorCode} raw={operation.recoveryFailure} log={operation.diagnosticLog} />
      )}
      {operation.instruction && (
        <CommunityMessage status="warning" title={t('Recovery instructions')}>
          {locale === 'en'
            ? operation.instruction
            : t(
                operation.stopFailure
                  ? 'Recovery and service shutdown failed; admission is unverified. Stop the managed service and inspect diagnostics. Run sudo bash install.sh --upgrade recover --output json; inspect the diagnostic log before resuming work.'
                  : 'Keep maintenance closed. Run sudo bash install.sh --upgrade recover --output json; inspect the diagnostic log before resuming work.',
              )}
        </CommunityMessage>
      )}
      {operation.phase === 'recovery-failed' && (
        <Link
          className="font-semibold"
          href={
            locale === 'zh-CN'
              ? 'https://github.com/dake6767/dsh-phalanx/blob/main/docs/install.zh-CN.md#recoverable-system-updates'
              : 'https://github.com/dake6767/dsh-phalanx/blob/main/docs/install.md#recoverable-system-updates'
          }
          target="_blank"
          rel="noreferrer"
        >
          {t('Open recovery instructions')}
        </Link>
      )}
      {['restored', 'prepare-failed', 'apply-failed'].includes(operation.phase) && (
        <Button isDisabled={disabled} onPress={retryUpdate}>
          {t('Check for updates and retry')}
        </Button>
      )}
      {children}
      <DiskFacts operation={operation} />
      <CleanupFacts operation={operation} disabled={disabled} retry={retryCleanup} />
      <UpdateDisclosure title={t('Update diagnostics')}>
        <p>{t('Operation: {id}', { id: operation.id })}</p>
        {operation.diagnosticLog && <p>{t('Diagnostic log: {path}', { path: operation.diagnosticLog })}</p>}
        {operation.failure && <pre className="update-notes">{operation.failure}</pre>}
        {operation.recoveryFailure && <pre className="update-notes">{operation.recoveryFailure}</pre>}
        {operation.stopFailure && <pre className="update-notes">{operation.stopFailure}</pre>}
        {locale !== 'en' && operation.instruction && <pre className="update-notes">{operation.instruction}</pre>}
        <ol>
          {events.map((event, index) => (
            <li key={index}>
              {systemUpdateText(event.phaseCode ?? '', locale) ?? event.phase}: {event.status} · {event.action ?? event.message} · {event.message}
              {event.bytes !== undefined && ` (${updateSize(event.bytes, locale)}${event.total === undefined ? '' : ` / ${updateSize(event.total, locale)}`})`}
            </li>
          ))}
        </ol>
      </UpdateDisclosure>
    </div>
  )
}
