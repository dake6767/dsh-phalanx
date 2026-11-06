import { useId, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Card } from '@heroui/react/card'
import { Chip } from '@heroui/react/chip'
import type { CommunitySkillPackView, CommunitySkillView } from '../../src/domain/admin-contract'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityIcon from './CommunityIcon'
import CommunityMessage from './CommunityMessage'

export default function CommunitySkillPackRow({
  pack,
  skills,
  onSkill,
  onPack,
  originName,
}: {
  pack: CommunitySkillPackView
  skills: ReadonlyMap<string, CommunitySkillView>
  onSkill: (name: string) => void
  onPack: (name: string) => void
  originName: (origin: string) => string
}) {
  const { t } = usePlatformLanguage()
  const [expanded, setExpanded] = useState(false)
  const contents = useId()
  return (
    <Card className="plugin-library-card">
      <Card.Header>
        <div className="plugin-card-top">
          <span className="plugin-card-icon" aria-hidden="true">
            <CommunityIcon name="skills" size={20} />
          </span>
          <Chip size="sm" variant="soft">
            {t('Skill pack')}
          </Chip>
          {pack.published ? (
            <Chip size="sm" variant="soft" color="success">
              {t('Published')}
            </Chip>
          ) : null}
          {pack.suiteOrigin ? (
            <Chip size="sm" variant="soft" color="accent">
              {t('From “{name}”', { name: originName(pack.suiteOrigin) })}
            </Chip>
          ) : null}
        </div>
        <Card.Title>{pack.name}</Card.Title>
        <Card.Description>{pack.description}</Card.Description>
      </Card.Header>
      <Card.Content>
        <p>{pack.empty ? t('Empty pack — hidden from members') : t('{count} skills', { count: pack.skills.length })}</p>
        {pack.conflict ? <CommunityMessage status="warning" title={t('Conflicts with a bundled runtime skill. Distribution is paused.')} /> : null}
        <Button
          variant="secondary"
          size="sm"
          isDisabled={pack.empty}
          aria-expanded={expanded}
          aria-controls={expanded ? contents : undefined}
          aria-label={t(expanded ? 'Collapse skill pack {name}' : 'Expand skill pack {name}', { name: pack.name })}
          onPress={() => setExpanded(value => !value)}
        >
          {t(expanded ? 'Collapse skills' : 'Expand skills')}
        </Button>
        {expanded ? (
          <ul id={contents} className="skill-pack-children">
            {pack.skills.map(name => {
              const skill = skills.get(name)
              return skill ? (
                <li key={name}>
                  <Button variant="tertiary" size="sm" aria-label={t('View skill {name}', { name })} onPress={() => onSkill(name)}>
                    {name}
                  </Button>
                  <p>{skill.description}</p>
                  {skill.conflict ? <CommunityMessage status="warning" title={t('Conflicts with a bundled runtime skill. Distribution is paused.')} /> : null}
                </li>
              ) : null
            })}
          </ul>
        ) : null}
      </Card.Content>
      <Card.Footer>
        <Button variant="tertiary" size="sm" aria-label={t('View skill pack {name}', { name: pack.name })} onPress={() => onPack(pack.name)}>
          {t('Skill pack details')}
          <CommunityIcon name="chevron" size={14} />
        </Button>
      </Card.Footer>
    </Card>
  )
}
