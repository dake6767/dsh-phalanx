import { Button } from '@heroui/react/button'
import type { CommunityMcpSettings, CommunityMcpPublicationImpact } from '../../src/domain/admin-contract'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityDialog from './CommunityDialog'
import CommunityPublicationSection from './CommunityPublicationSection'

export function CommunityMcpPublicationSection({
  settings,
  busy,
  dirty,
  onReview,
  onDiscard,
}: {
  settings?: CommunityMcpSettings
  busy: boolean
  dirty: boolean
  onReview: () => void
  onDiscard: () => void
}) {
  const { t } = usePlatformLanguage()
  return (
    <CommunityPublicationSection
      published={settings?.published ?? false}
      unavailable={
        !!settings &&
        (settings.testStatus !== 'passed' ||
          (settings.catalog !== undefined && settings.catalog.status !== 'ready') ||
          (settings.preparation !== undefined && settings.preparation.stage !== 'ready'))
      }
      reason={
        settings?.published &&
        (settings.testStatus !== 'passed' ||
          (settings.catalog !== undefined && settings.catalog.status !== 'ready') ||
          (settings.preparation !== undefined && settings.preparation.stage !== 'ready'))
          ? t('Service preparation or connection is not ready.')
          : undefined
      }
    >
      <p>{t('Publishing lets all members select this resource when it is available.')}</p>
      <p>{t('Unpublishing removes self-selected services. Group grants are kept.')}</p>
      <p>{t('Republishing does not restore removed member selections.')}</p>
      {!settings ? (
        <p>{t('Save this resource before publishing.')}</p>
      ) : (
        <>
          <Button
            variant="secondary"
            isDisabled={busy || dirty || (!settings.published && settings.testStatus !== 'passed')}
            onPress={() => {
              onReview()
            }}
          >
            {t(settings.published ? 'Unpublish MCP service' : 'Publish MCP service')}
          </Button>
          {dirty ? (
            <>
              <p>{t('Save or discard changes before publishing.')}</p>
              <Button variant="tertiary" isDisabled={busy} onPress={onDiscard}>
                {t('Discard changes')}
              </Button>
            </>
          ) : null}
          {!settings.published && settings.testStatus !== 'passed' ? <p>{t('Test this service successfully before publishing.')}</p> : null}
        </>
      )}
    </CommunityPublicationSection>
  )
}

export function CommunityMcpPublicationConfirmation({
  publication,
  busy,
  onConfirm,
  onCancel,
}: {
  publication?: CommunityMcpPublicationImpact
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = usePlatformLanguage()
  return publication ? (
    <CommunityDialog
      title={t(publication.published ? 'Confirm MCP unpublication' : 'Confirm MCP publication')}
      busy={busy}
      onClose={() => onCancel()}
      footer={
        <>
          <Button variant="tertiary" isDisabled={busy} onPress={() => onCancel()}>
            {t('Cancel')}
          </Button>
          <Button
            isDisabled={busy}
            onPress={() => {
              onConfirm()
            }}
          >
            {t('Confirm')}
          </Button>
        </>
      }
    >
      <p>{t('{count} member selections', { count: publication.selectedMembers })}</p>
      <p>
        {t(
          publication.published
            ? 'Unpublishing removes self-selected services. Group grants are kept.'
            : 'Publishing lets all members select this resource when it is available.',
        )}
      </p>
      {publication.hasPlatformCredential ? <p>{t('All members can use the platform credentials through this resource.')}</p> : null}
      <p>{t('Republishing does not restore removed member selections.')}</p>
    </CommunityDialog>
  ) : null
}
