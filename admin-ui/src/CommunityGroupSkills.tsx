import { Chip } from '@heroui/react/chip'
import type { CommunitySkillGroupView } from '../../src/domain/admin-contract'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityGrantList from './CommunityGrantList'

const packId = (name: string) => `pack:${name}`

/** Packs and skills share one granted list; ids are prefixed so the two selections stay separate. */
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
  const conflict = (
    <Chip size="sm" variant="soft" color="danger">
      {t('Conflicts with a bundled skill')}
    </Chip>
  )
  const packRows = (data.packs ?? []).map(pack => ({
    id: packId(pack.name),
    name: pack.name,
    meta: t('Skill pack · {count} skills', { count: pack.skills.length }),
    tags: pack.empty ? (
      <Chip size="sm" variant="soft" color="warning">
        {t('Empty pack — hidden from members')}
      </Chip>
    ) : null,
  }))
  const packOf = (name: string) => (data.packs ?? []).filter(pack => pack.skills.includes(name)).map(pack => pack.name)
  const skillRows = data.skills.map(skill => ({
    id: skill.name,
    name: skill.name,
    meta: skill.topLevel ? undefined : t('In skill pack {name}', { name: packOf(skill.name).join(', ') }),
    tags: skill.conflict ? conflict : null,
    locked: skill.conflict,
  }))
  const rows = [...packRows, ...skillRows]
  const ids = [...packs.map(packId), ...selected]
  return (
    <CommunityGrantList
      rows={rows}
      selected={ids}
      // Packs first, then standalone skills, then skills that also come with a pack.
      candidates={[...packRows, ...skillRows.filter(row => !row.meta), ...skillRows.filter(row => row.meta)].filter(row => !ids.includes(row.id))}
      onChange={next => {
        onPacks(next.filter(id => id.startsWith('pack:')).map(id => id.slice(5)))
        onSelect(next.filter(id => !id.startsWith('pack:')))
      }}
      busy={busy}
      addLabel={t('Add skills')}
      dialogTitle={t('Add skills')}
      emptyLabel={t('No granted skills')}
      noCandidatesLabel={t('No skills available to add')}
    />
  )
}
