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
  action,
  consequence,
  children,
}: {
  published: boolean
  paused?: boolean
  unavailable?: boolean
  reason?: ReactNode
  action: ReactNode
  consequence?: string
  children?: ReactNode
}) {
  const { t } = usePlatformLanguage()
  return (
    <CommunityGrantSection
      title={t('Platform App Center')}
      action={
        <div className="publication-controls">
          {reason ? <span className="publication-reason">{reason}</span> : null}
          <CommunityPublicationStatus published={published} paused={paused} unavailable={unavailable} />
          {action}
        </div>
      }
    >
      <p className="section-note">
        {consequence ?? t(published ? 'Members can select this resource when it is available.' : 'Members cannot select this resource in the app center.')}
      </p>
      {children}
    </CommunityGrantSection>
  )
}
