import { Button } from '@heroui/react/button'
import type { CommunitySystemUpdateCheck } from '../../src/domain/admin-contract'
import { systemUpdateText } from '../../src/domain/system-update-codes'
import { usePlatformLanguage } from './CommunityLanguage'
import { UpdateDisclosure, UpdateFailure } from './CommunitySystemUpdateDetails'

export default function SystemUpdateCheck({
  check,
  disabled,
  prepare,
}: {
  check: CommunitySystemUpdateCheck
  disabled: boolean
  prepare: (version: string, manifestSha256: string) => void
}) {
  const { t, locale } = usePlatformLanguage()
  const code =
    check.outcomeCode ?? (check.status === 'available' ? 'update.available' : check.status === 'current' ? 'update.current' : 'compatibility.unsupported')
  const version = 'version' in check ? check.version : undefined
  const required = check.requiredVersion && (check.requiredVersion.startsWith('v') ? check.requiredVersion : `v${check.requiredVersion}`)
  // A breakpoint must use its own verified row, never the latest release's digest.
  const target =
    code === 'update.breakpoint-required'
      ? 'versions' in check
        ? check.versions?.find(row => row.version === required && row.status === 'available')
        : undefined
      : check.status === 'available'
        ? check
        : undefined
  const verifiedTarget = target && /^(?:v\d+\.\d+\.\d+|run-[1-9][0-9]*)$/u.test(target.version) && /^[a-f0-9]{64}$/u.test(target.manifestSha256)
  const needsAction = code === 'update.available' || code === 'update.breakpoint-required' || code === 'update.channel-switch'
  return (
    <div aria-live="polite">
      <h3>
        {!check.outcomeCode && (check.status === 'failed' || check.status === 'stale')
          ? t('Unable to check the release source')
          : (systemUpdateText(code, locale) ?? t('Use the documented installer path.'))}
      </h3>
      {version && <p>{t(check.status === 'available' ? 'Formal update available: {version}' : 'Release: {version}', { version })}</p>}
      {check.status === 'incompatible' && check.freshInstallRequired && <p>{t('This version requires a fresh installation.')}</p>}
      {'reason' in check &&
        check.reason &&
        (check.errorCode ? (
          <UpdateFailure code={check.errorCode} raw={check.reason} log={check.diagnosticLog} />
        ) : (
          !check.outcomeCode && <p className="update-notes">{t('Update availability unknown: {reason}', { reason: check.reason })}</p>
        ))}
      {(code === 'update.below-floor' || code === 'update.reader-update-required' || (check.status === 'incompatible' && check.freshInstallRequired)) && (
        <p>
          <a
            href={
              locale === 'zh-CN'
                ? 'https://github.com/dake6767/dsh-phalanx/blob/main/docs/install.zh-CN.md#recoverable-system-updates'
                : 'https://github.com/dake6767/dsh-phalanx/blob/main/docs/install.md#recoverable-system-updates'
            }
            target="_blank"
            rel="noreferrer"
          >
            {t(check.status === 'incompatible' && check.freshInstallRequired ? 'Fresh installation instructions' : 'Use the documented installer path.')}
          </a>
        </p>
      )}
      <p>{t('Checked: {time}', { time: new Date(check.checkedAt).toLocaleString(locale) })}</p>
      {'releaseNotes' in check && (
        <UpdateDisclosure title={t('Release notes')} defaultExpanded>
          <pre className="update-notes">{check.releaseNotes || t('No release notes supplied.')}</pre>
        </UpdateDisclosure>
      )}
      {needsAction && (
        <Button
          isDisabled={disabled || !verifiedTarget}
          onPress={() => {
            if (verifiedTarget) prepare(target.version, target.manifestSha256)
          }}
        >
          {code === 'update.breakpoint-required'
            ? t('Update to {version}', { version: required ?? t('Unknown') })
            : code === 'update.channel-switch'
              ? t('Switch to formal {version}', { version: version ?? t('Unknown') })
              : t('Update to latest version')}
        </Button>
      )}
    </div>
  )
}
