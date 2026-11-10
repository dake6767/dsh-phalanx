import { pluginStageLabels } from './community-plugin-stage'
import { useState } from 'react'
import { Button } from '@heroui/react/button'
import type { CommunityPluginView } from '../../src/domain/admin-contract'
import { communityPluginImpact, communityPlugins, publishCommunityPlugin } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityDialog from './CommunityDialog'
import CommunityMessage from './CommunityMessage'
import CommunityPublicationSection from './CommunityPublicationSection'

export default function CommunityPluginPublication({
  plugin,
  onChanged,
  onRequest,
}: {
  plugin: CommunityPluginView
  onChanged: () => void
  onRequest: (action: () => void) => void
}) {
  const { t, errorText } = usePlatformLanguage()
  const [confirmation, setConfirmation] = useState<{ plugin: CommunityPluginView; published: boolean; count: number }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const review = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const [plugins, impact] = await Promise.all([communityPlugins(), communityPluginImpact(plugin.packageName)])
      const current = plugins.find(row => row.packageName === plugin.packageName)
      if (!current) throw new Error('Plugin was not found.')
      setConfirmation({ plugin: current, published: !current.published && !current.publicationPaused, count: impact.selectedMembers ?? 0 })
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  const apply = async () => {
    if (!confirmation || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await publishCommunityPlugin({
        action: 'publish',
        packageName: confirmation.plugin.packageName,
        published: confirmation.published,
        confirmed: true,
        ...(confirmation.published ? {} : { selectedMembers: confirmation.count }),
      })
    } catch (failure) {
      setError(failure)
    } finally {
      setConfirmation(undefined)
      setBusy(false)
      onChanged()
    }
  }
  const consequences = (value: CommunityPluginView) =>
    t(
      value.hasPlatformCredential
        ? 'Shared-key member selections stop loading after restart. Group grants remain.'
        : 'Installed member copies are kept. Group grants remain.',
    )
  return (
    <CommunityPublicationSection
      published={plugin.published}
      paused={plugin.publicationPaused}
      unavailable={plugin.incompatible || plugin.stage !== 'available'}
      reason={
        plugin.publicationPaused
          ? t('Publication remains paused until a compatible version is selected. Cancel automatic republication to keep it unpublished.')
          : plugin.incompatible
            ? t('Incompatible with the current version')
            : plugin.stage !== 'available'
              ? t(pluginStageLabels[plugin.stage])
              : undefined
      }
    >
      <p>{t('Publishing lets all members select this resource when it is available.')}</p>
      <p>{consequences(plugin)}</p>
      <p>{t('Republishing does not restore removed member selections.')}</p>
      <p>{t('{count} member selections', { count: plugin.selectedMembers ?? 0 })}</p>
      {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
      <Button
        variant="secondary"
        isDisabled={busy || plugin.removing || (!plugin.published && !plugin.publicationPaused && plugin.stage !== 'available')}
        onPress={() =>
          onRequest(() => {
            void review()
          })
        }
      >
        {t(plugin.publicationPaused ? 'Cancel automatic republication' : plugin.published ? 'Unpublish resource' : 'Publish resource')}
      </Button>
      {confirmation ? (
        <CommunityDialog
          title={t(confirmation.published ? 'Confirm resource publication' : 'Confirm resource unpublication')}
          busy={busy}
          onClose={() => setConfirmation(undefined)}
          footer={
            <>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setConfirmation(undefined)}>
                {t('Cancel')}
              </Button>
              <Button
                variant={confirmation.published ? 'primary' : 'danger'}
                isDisabled={busy}
                onPress={() => {
                  void apply()
                }}
              >
                {t('Confirm')}
              </Button>
            </>
          }
        >
          <p>
            {t(
              confirmation.published
                ? 'Publishing lets all members select this resource when it is available.'
                : 'This affects {count} members who selected this plugin.',
              {
                count: confirmation.count,
              },
            )}
          </p>
          {confirmation.plugin.hasPlatformCredential ? <p>{t('All members can use the platform credentials through this resource.')}</p> : null}
          {!confirmation.published ? <p>{consequences(confirmation.plugin)}</p> : null}
          <p>{t('Republishing does not restore removed member selections.')}</p>
        </CommunityDialog>
      ) : null}
    </CommunityPublicationSection>
  )
}
