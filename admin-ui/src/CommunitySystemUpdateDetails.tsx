import { Button } from '@heroui/react/button'
import { Disclosure } from '@heroui/react/disclosure'
import type { ReactNode } from 'react'
import type { CommunitySystemUpdateOperation } from '../../src/domain/admin-contract'
import { en as updateMessages } from '../../src/domain/model-update-messages'
import { systemUpdateCodes, systemUpdateText } from '../../src/domain/system-update-codes'
import type { PlatformMessageKey } from '../../src/domain/platform-copy'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityMessage from './CommunityMessage'

export function UpdateDisclosure({ title, defaultExpanded = false, children }: { title: string; defaultExpanded?: boolean; children: ReactNode }) {
  return (
    <Disclosure className="update-disclosure" defaultExpanded={defaultExpanded}>
      <Disclosure.Heading>
        <Button slot="trigger" variant="ghost" size="sm">
          {title}
          <Disclosure.Indicator />
        </Button>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body>{children}</Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  )
}

export function updateSize(bytes: number, locale: string): string {
  const unit = bytes >= 1024 ** 3 ? 'GB' : 'MB',
    value = bytes / (unit === 'GB' ? 1024 ** 3 : 1024 ** 2)
  return `${value > 0 && value < 0.001 ? '<0.001' : value.toLocaleString(locale, { maximumFractionDigits: 3 })} ${unit}`
}

export function UpdateFailure({
  code,
  raw,
  log,
  label = 'Update failure: {error}',
}: {
  code: string | undefined
  raw: string
  log?: string | undefined
  label?: PlatformMessageKey
}) {
  const { t, locale } = usePlatformLanguage()
  const known = code !== 'unknown' && code !== undefined && Object.hasOwn(systemUpdateCodes.errors, code)
  return (
    <CommunityMessage status="danger" title={t(label, { error: known ? systemUpdateText(code, locale)! : raw })}>
      {!known && (
        <>
          <p>{t('An unclassified update error occurred. Inspect the diagnostic log and contact the administrator.')}</p>
          <p>{t('Diagnostic log: {path}', { path: log ?? t('Unknown') })}</p>
        </>
      )}
    </CommunityMessage>
  )
}

export function DiskFacts({ operation }: { operation: CommunitySystemUpdateOperation }) {
  const { t, locale } = usePlatformLanguage()
  const space = operation.space
  if (!space) return null
  return (
    <UpdateDisclosure key={String(space.sufficient)} title={t('Disk capacity')} defaultExpanded={!space.sufficient}>
      <section aria-label={t('Disk capacity')}>
        <CommunityMessage
          status={space.sufficient ? 'success' : 'danger'}
          title={t(space.sufficient ? 'Enough space for the planned writes.' : 'Insufficient space. The running service has not been stopped.')}
        />
        {space.locations.map((location, index) => (
          <div key={index}>
            <p>{location.paths.join(' · ')}</p>
            <p>
              {t('Required: {required} · Available: {available} · Shortfall: {shortfall}', {
                required: updateSize(location.requiredBytes, locale),
                available: updateSize(location.availableBytes, locale),
                shortfall: updateSize(location.shortfallBytes, locale),
              })}
            </p>
          </div>
        ))}
      </section>
    </UpdateDisclosure>
  )
}

export function CleanupFacts({ operation, disabled, retry }: { operation: CommunitySystemUpdateOperation; disabled: boolean; retry: () => void }) {
  const { t, locale } = usePlatformLanguage()
  const cleanup = operation.cleanup
  if (!cleanup) return null
  const message =
    cleanup.status === 'running'
      ? 'Cleaning unused installation resources…'
      : cleanup.status === 'succeeded'
        ? 'Unused installation resources cleaned.'
        : operation.phase === 'succeeded'
          ? 'Update succeeded; some resources still need cleanup.'
          : 'Some resources still need cleanup.'
  const canRetry = ['succeeded', 'restored', 'prepared', 'prepare-failed', 'apply-failed'].includes(operation.phase)
  return (
    <UpdateDisclosure key={String(cleanup.status === 'failed')} title={t('Installation resource cleanup')} defaultExpanded={cleanup.status === 'failed'}>
      <CommunityMessage status={cleanup.status === 'failed' ? 'warning' : cleanup.status === 'succeeded' ? 'success' : 'accent'} title={t(message)} />
      <p>{t('Space reclaimed: {size}', { size: updateSize(cleanup.reclaimedBytes, locale) })}</p>
      {cleanup.failure && <UpdateFailure code={cleanup.errorCode} raw={cleanup.failure} log={operation.diagnosticLog} />}
      {canRetry && (
        <Button variant="secondary" isPending={cleanup.status === 'running'} isDisabled={disabled || cleanup.status === 'running'} onPress={retry}>
          {t('Retry cleanup')}
        </Button>
      )}
      <ul>
        {cleanup.items.map((item, index) => (
          <li key={index}>
            <p>{item.name}</p>
            <p>
              {t(`cleanup.${item.status}`)} · {Object.hasOwn(updateMessages, item.reason) ? t(item.reason as keyof typeof updateMessages) : item.reason}
            </p>
          </li>
        ))}
      </ul>
      {Boolean(cleanup.omittedItems) && <p>{t('{count} more entries are retained in the protected operation journal.', { count: cleanup.omittedItems! })}</p>}
    </UpdateDisclosure>
  )
}
