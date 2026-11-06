import { useId, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Checkbox } from '@heroui/react/checkbox'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityMessage from './CommunityMessage'

/** Presentation never removes choices from the parent's saved selection. */
export default function CommunitySkillChoices({
  skills,
  packs,
  selected,
  selectedPacks,
  onSkills,
  onPacks,
  busy,
}: {
  skills: readonly { name: string; description: string; topLevel: boolean; conflict?: boolean }[]
  packs: readonly { name: string; description: string; skills: readonly string[]; conflict?: boolean }[]
  selected: readonly string[]
  selectedPacks: readonly string[]
  onSkills: (names: readonly string[]) => void
  onPacks: (names: readonly string[]) => void
  busy: boolean
}) {
  const { t } = usePlatformLanguage()
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const id = useId()
  const skillByName = new Map(skills.map(skill => [skill.name, skill]))
  const choice = (row: { name: string; description: string; conflict?: boolean }, pack = false) => {
    const values = pack ? selectedPacks : selected
    const update = pack ? onPacks : onSkills
    return (
      <div className="group-grant-item">
        <Checkbox
          isSelected={values.includes(row.name)}
          isDisabled={busy || (!!row.conflict && !values.includes(row.name))}
          onChange={checked => update(checked ? [...values, row.name] : values.filter(name => name !== row.name))}
        >
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            {row.name}
          </Checkbox.Content>
        </Checkbox>
        <p className="text-sm text-muted">{row.description}</p>
        {row.conflict ? <CommunityMessage status="danger" title={t('Conflicts with a bundled runtime skill. Distribution is paused.')} /> : null}
      </div>
    )
  }
  return (
    <div className="group-grants-list">
      {packs.map((pack, index) => {
        const open = expanded.includes(pack.name),
          contents = `${id}-${index}`
        return (
          <div key={pack.name}>
            {choice(pack, true)}
            <Button
              variant="tertiary"
              size="sm"
              isDisabled={!pack.skills.length}
              aria-expanded={open}
              aria-controls={open ? contents : undefined}
              aria-label={t(open ? 'Collapse skill pack {name}' : 'Expand skill pack {name}', { name: pack.name })}
              onPress={() => setExpanded(values => (open ? values.filter(name => name !== pack.name) : [...values, pack.name]))}
            >
              {t(open ? 'Collapse skills' : 'Expand skills')}
            </Button>
            {!pack.skills.length ? <p>{t('Empty pack — hidden from members')}</p> : null}
            {open ? (
              <ul id={contents} className="skill-pack-children">
                {pack.skills.map(name => {
                  const skill = skillByName.get(name)
                  return skill ? <li key={name}>{choice(skill)}</li> : null
                })}
              </ul>
            ) : null}
          </div>
        )
      })}
      {skills
        .filter(skill => skill.topLevel)
        .map(skill => (
          <div key={skill.name}>{choice(skill)}</div>
        ))}
      {!skills.length && !packs.length ? <p>{t('No skills yet')}</p> : null}
    </div>
  )
}
