import type { ReactNode } from 'react'
import { Chip } from '@heroui/react/chip'
import CommunityGrantSection from './CommunityGrantSection'
import { usePlatformLanguage } from './CommunityLanguage'

export function CommunityPublicationStatus({
  published,
  paused = false,
  unavailable = false,
}: {
  published: boolean
  paused?: boolean
  unavailable?: boolean
}) {
  const { t } = usePlatformLanguage()
  return (
    <Chip size="sm" variant="soft" color={paused || (published && unavailable) ? 'warning' : published ? 'success' : 'default'}>
      {t(
        paused
          ? 'Publication paused · automatic return enabled'
          : published
            ? unavailable
              ? 'Published · temporarily unavailable'
              : 'Resource published'
            : 'Resource not published',
      )}
    </Chip>
  )
}

/** Shared presentation only; each resource owns its confirmation and publication transaction. */
export default function CommunityPublicationSection({
  published,
  paused,
  unavailable,
  reason,
  children,
}: {
  published: boolean
  paused?: boolean
  unavailable?: boolean
  reason?: ReactNode
  children: ReactNode
}) {
  const { t } = usePlatformLanguage()
  return (
    <CommunityGrantSection
      title={t('Platform App Center')}
      action={<CommunityPublicationStatus published={published} paused={paused} unavailable={unavailable} />}
    >
      {reason ? <p className="section-note">{reason}</p> : null}
      {children}
    </CommunityGrantSection>
  )
}
