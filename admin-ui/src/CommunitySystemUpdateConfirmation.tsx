import { AlertDialog } from '@heroui/react/alert-dialog'
import { Button } from '@heroui/react/button'
import type { CommunitySystemUpdateOperation } from '../../src/domain/admin-contract'
import { usePlatformLanguage } from './CommunityLanguage'

export default function CommunitySystemUpdateConfirmation({
  operation,
  previousDowntimeSeconds,
  disabled,
  onCancel,
  onConfirm,
}: {
  operation: CommunitySystemUpdateOperation
  previousDowntimeSeconds: number | undefined
  disabled: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t, locale } = usePlatformLanguage()
  const title = t('Apply update: {version}', { version: operation.targetVersion })
  const backup =
    locale === 'zh-CN'
      ? 'https://github.com/dake6767/dsh-phalanx/blob/main/docs/install.zh-CN.md#一致备份与整机迁移'
      : 'https://github.com/dake6767/dsh-phalanx/blob/main/docs/install.md#consistent-backup-and-whole-host-migration'
  return (
    <AlertDialog>
      <AlertDialog.Backdrop
        isOpen
        isDismissable={!disabled}
        isKeyboardDismissDisabled={disabled}
        onOpenChange={open => {
          if (!open && !disabled) onCancel()
        }}
      >
        <AlertDialog.Container size="md">
          <AlertDialog.Dialog className="platform-dialog" aria-label={title}>
            <AlertDialog.Header>
              <AlertDialog.Heading>{title}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>
                {t(
                  'The service will be temporarily unavailable. All user instances will restart, all running tasks will be interrupted, and unsaved work may be lost. Confirming starts the update immediately.',
                )}
              </p>
              <p>
                {previousDowntimeSeconds === undefined
                  ? t('Estimated downtime: usually a few minutes.')
                  : t('Estimated downtime: {seconds}s (last update).', { seconds: Math.round(previousDowntimeSeconds) })}
              </p>
              <p>
                {t(
                  'The update does not back up member files. If the update fails, the platform restores automatically and member files are unaffected. Back up the user data directory regularly.',
                )}
              </p>
              <p>
                <a href={backup} target="_blank" rel="noreferrer">
                  {t('User data backup instructions')}
                </a>
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="tertiary" isDisabled={disabled} onPress={onCancel}>
                {t('Cancel')}
              </Button>
              <Button variant="danger" isDisabled={disabled} onPress={onConfirm}>
                {t('Confirm and apply now')}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  )
}
