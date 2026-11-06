import type { CommunitySkillImportPreview } from '../../src/domain/admin-contract'
import { skillImportFailureMessages } from '../../src/domain/skill-import-messages'
import { usePlatformLanguage } from './CommunityLanguage'

export default function CommunitySkillImportFailures({ failures }: { failures: CommunitySkillImportPreview['failures'] }) {
  const { t } = usePlatformLanguage()
  if (!failures.length) return null
  const title = t('Unable to import ({count})', { count: failures.length })
  return (
    <section className="page-stack" aria-label={title}>
      <h3>{title}</h3>
      <ul className="page-stack">
        {failures.map(failure => (
          <li key={failure.path}>
            <code>{failure.path}</code>
            <p>{t('Field: {field}', { field: failure.field })}</p>
            <p>{t(skillImportFailureMessages[failure.reasonCode])}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
