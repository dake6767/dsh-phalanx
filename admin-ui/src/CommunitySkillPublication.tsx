import CommunityPublicationSection from './CommunityPublicationSection'
import { useState } from 'react'
import { Button } from '@heroui/react/button'
import type { CommunitySkillDetail } from '../../src/domain/admin-contract'
import { changeCommunitySkill, communitySkillDetail } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityDialog from './CommunityDialog'
import CommunityMessage from './CommunityMessage'

export default function CommunitySkillPublication({ detail }: { detail: CommunitySkillDetail }) {
  const { t, errorText } = usePlatformLanguage()
  const [confirmation, setConfirmation] = useState<CommunitySkillDetail>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>()
  const title = confirmation?.published ? 'Confirm skill unpublication' : 'Confirm skill publication'
  const review = async () => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      setConfirmation(await communitySkillDetail(detail.name))
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
      await changeCommunitySkill({ action: 'publish', name: confirmation.name, published: !confirmation.published, revision: confirmation.revision })
      setConfirmation(undefined)
    } catch (failure) {
      setError(failure)
      setConfirmation(undefined)
    } finally {
      setBusy(false)
    }
  }
  return (
    <CommunityPublicationSection
      published={detail.published}
      unavailable={detail.conflict}
      reason={detail.conflict ? t('Conflicts with a bundled runtime skill. Distribution is paused.') : undefined}
    >
      <p>{t('Publishing lets all members select this resource when it is available.')}</p>
      <p>{t('Unpublishing clears selections of this skill. Group grants and skill packs are kept.')}</p>
      <p>{t('Republishing does not restore removed member selections.')}</p>
      {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
      <Button
        variant="secondary"
        isDisabled={busy || (!detail.published && !!detail.conflict)}
        onPress={() => {
          void review()
        }}
      >
        {t(detail.published ? 'Unpublish resource' : 'Publish resource')}
      </Button>
      {confirmation ? (
        <CommunityDialog
          title={t(title)}
          busy={busy}
          onClose={() => setConfirmation(undefined)}
          footer={
            <>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setConfirmation(undefined)}>
                {t('Cancel')}
              </Button>
              <Button
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
          <p>{confirmation.name}</p>
          <p>
            {t(
              confirmation.published
                ? 'Unpublishing clears selections of this skill. Group grants and skill packs are kept.'
                : 'Publishing lets all members select this resource when it is available.',
            )}
          </p>
          {confirmation.hasPlatformCredential ? <p>{t('All members can use the platform credentials through this resource.')}</p> : null}
          <p>{t('Republishing does not restore removed member selections.')}</p>
          <p>{t('{count} members selected this skill.', { count: confirmation.selectedMembers })}</p>
          <CommunityMessage status="warning" title={t('Changes apply to new sessions. Running tasks using this skill may fail.')} />
        </CommunityDialog>
      ) : null}
    </CommunityPublicationSection>
  )
}
