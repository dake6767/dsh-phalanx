import type { ContributionMaintenanceReview } from '../../src/domain/library-contribution'
import { usePlatformLanguage } from './CommunityLanguage'
export default function CommunityContributionChanges({ review }: { review?: ContributionMaintenanceReview }) {
  const { t } = usePlatformLanguage()
  if (!review) return null
  return (
    <section className="plugin-detail-section" aria-label={t('Update changes')}>
      <h3>{t('Maintainer')}</h3>
      <p>{review.maintainer?.username ?? t('No maintainer')}</p>
      {review.canAssignMaintainer ? (
        <p>{t('Assigning the contributor to this existing entry is optional.')}</p>
      ) : !review.maintainer ? (
        <p>{t('The contributor becomes the maintainer of a new entry.')}</p>
      ) : null}
      {review.changes ? (
        <>
          <h3>{t('Update changes')}</h3>
          {(['added', 'changed', 'deleted'] as const).map(kind => (
            <div key={kind}>
              <strong>{t(kind === 'added' ? 'Added files' : kind === 'changed' ? 'Changed files' : 'Deleted files')}</strong>
              {review.changes![kind].length ? (
                <ul>
                  {review.changes![kind].map(path => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>—</p>
              )}
            </div>
          ))}
          {review.changes.declaration ? (
            <>
              <h4>{t('Previous declaration')}</h4>
              <pre className="plugin-raw-config">{JSON.stringify(review.changes.declaration.before ?? {}, null, 2)}</pre>
              <h4>{t('New declaration')}</h4>
              <pre className="plugin-raw-config">{JSON.stringify(review.changes.declaration.after, null, 2)}</pre>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
