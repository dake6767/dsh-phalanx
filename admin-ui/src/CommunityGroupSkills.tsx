import type { CommunitySkillGroupView } from '../../src/domain/admin-contract'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunitySkillChoices from './CommunitySkillChoices'

export default function CommunityGroupSkills({
  data,
  selected,
  onSelect,
  busy,
  packs,
  onPacks,
}: {
  data: CommunitySkillGroupView | undefined
  selected: readonly string[]
  onSelect: (names: readonly string[]) => void
  busy: boolean
  packs: readonly string[]
  onPacks: (names: readonly string[]) => void
}) {
  const { t } = usePlatformLanguage()
  if (!data) return <p role="status">{t('Loading…')}</p>
  return (
    <section className="group-grants" aria-label={t('Skill grants')}>
      <div className="group-grants-intro">
        <h3>{t('Skill grants')}</h3>
        <p>{t('Skill grant changes apply to new sessions without restarting instances.')}</p>
        {data.group.kind === 'admin' ? <p>{t('Administrator instances only receive explicitly configured skills and skill packs.')}</p> : null}
      </div>
      <CommunitySkillChoices
        skills={data.skills}
        packs={(data.packs ?? []).map(pack => ({ ...pack, skills: pack.skills }))}
        selected={selected}
        selectedPacks={packs}
        onSkills={onSelect}
        onPacks={onPacks}
        busy={busy}
      />
    </section>
  )
}
