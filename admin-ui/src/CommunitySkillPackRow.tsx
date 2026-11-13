import { CommunityPublicationStatus } from './CommunityPublicationSection'
import { useState } from 'react'
import { Button } from '@heroui/react/button'
import { Card } from '@heroui/react/card'
import { Popover } from '@heroui/react/popover'
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
  const [open, setOpen] = useState(false)
  return (
    <Card className="plugin-library-card">
      <Card.Header>
        <div className="library-card-heading">
          <Card.Title>{pack.displayName ?? pack.name}</Card.Title>
          <CommunityIcon name="chevron" size={14} />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="plugin-summary-meta">
            {t('Skill pack')} · {pack.empty ? t('Empty pack — hidden from members') : t('{count} skills', { count: pack.skills.length })}
          </p>
          <Popover isOpen={open} onOpenChange={setOpen}>
            <Button
              className="skill-pack-toggle relative z-10"
              variant="secondary"
              size="sm"
              isDisabled={pack.empty}
              aria-label={t('View skills in {name}', { name: pack.name })}
            >
              {t('View skills')}
            </Button>
            <Popover.Content className="skill-pack-popover" placement="bottom start" offset={8}>
              <Popover.Arrow />
              <Popover.Dialog aria-label={pack.name}>
                <ul className="skill-pack-children">
                  {pack.skills.map(name => {
                    const skill = skills.get(name)
                    return skill ? (
                      <li key={name}>
                        <Button
                          variant="tertiary"
                          size="sm"
                          aria-label={t('View skill {name}', { name })}
                          onPress={() => {
                            setOpen(false)
                            onSkill(name)
                          }}
                        >
                          {name}
                        </Button>
                        {skill.conflict ? (
                          <CommunityMessage status="warning" title={t('Conflicts with a bundled runtime skill. Distribution is paused.')} />
                        ) : null}
                      </li>
                    ) : null
                  })}
                </ul>
              </Popover.Dialog>
            </Popover.Content>
          </Popover>
        </div>
        <Card.Description>{pack.description}</Card.Description>
      </Card.Header>
      {pack.unavailable === 'conflict' ? (
        <p className="plugin-card-error">{t('All pack skills conflict with the runtime and are temporarily unavailable.')}</p>
      ) : null}
      {pack.conflict ? <p className="plugin-card-error">{t('Conflicts with a bundled runtime skill. Distribution is paused.')}</p> : null}
      <Card.Footer className="plugin-card-status">
        {pack.suiteOrigin ? (
          <Chip size="sm" variant="soft" color="accent">
            {t('From “{name}”', { name: originName(pack.suiteOrigin) })}
          </Chip>
        ) : null}
        <CommunityPublicationStatus published={pack.published} unavailable={!!pack.unavailable} />
      </Card.Footer>
      <Button
        variant="tertiary"
        size="sm"
        className="plugin-details-action"
        aria-label={t('View skill pack {name}', { name: pack.name })}
        onPress={() => onPack(pack.name)}
      />
    </Card>
  )
}
