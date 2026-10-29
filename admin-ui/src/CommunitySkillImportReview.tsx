import { Checkbox } from '@heroui/react/checkbox'
import { Chip } from '@heroui/react/chip'
import type { CommunitySkillImportPreview } from '../../src/domain/admin-contract'
import { importDraft } from './community-import-draft'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityField from './CommunityField'
import CommunityMessage from './CommunityMessage'
import CommunitySelect from './CommunitySelect'
import CommunitySkillContent from './CommunitySkillContent'

export default function CommunitySkillImportReview({
  preview,
  draft,
  onChange,
  busy,
}: {
  preview: CommunitySkillImportPreview
  draft: ReturnType<typeof importDraft>
  onChange: (draft: ReturnType<typeof importDraft>) => void
  busy: boolean
}) {
  const { t } = usePlatformLanguage()
  const groups = preview.packs.length
    ? [
        ...preview.packs.map(pack => ({ name: pack.name, skills: preview.candidates.filter(row => pack.skills.includes(row.name)) })),
        { name: t('Other skills'), skills: preview.candidates.filter(row => !preview.packs.some(pack => pack.skills.includes(row.name))) },
      ]
    : [{ name: '', skills: preview.candidates }]
  const note = (name: string) =>
    onChange({ ...draft, note: name, names: [...new Set([...draft.names, ...(draft.note ? [draft.note] : [])])].filter(value => value !== name) })
  return (
    <div className="page-stack">
      <h2>{t('Import candidates')}</h2>
      <p>{t('Select skills and confirm each replacement before importing.')}</p>
      {preview.candidates.some(row => row.internal) ? (
        <Checkbox isSelected={draft.showInternal} onChange={showInternal => onChange({ ...draft, showInternal })} isDisabled={busy}>
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            {t('Show internal skills')}
          </Checkbox.Content>
        </Checkbox>
      ) : null}
      <CommunitySelect
        disabled={busy}
        label={t('Orchestration skill')}
        value={draft.note || 'none'}
        onChange={name => note(name === 'none' ? '' : name)}
        options={[{ id: 'none', label: t('No orchestration skill') }, ...preview.candidates.map(row => ({ id: row.name, label: row.name }))]}
      />
      {draft.note ? <p>{t('The orchestration skill is used as pack instructions, not imported separately.')}</p> : null}
      {groups
        .filter(group => group.skills.length)
        .map(group => (
          <section className="page-stack" key={group.name}>
            {group.name ? (
              <>
                <h3>{group.name}</h3>
                <Checkbox
                  isDisabled={busy}
                  isSelected={group.skills.filter(row => !row.internal && row.name !== draft.note).every(row => draft.names.includes(row.name))}
                  onChange={checked =>
                    onChange({
                      ...draft,
                      names: checked
                        ? [...new Set([...draft.names, ...group.skills.filter(row => !row.internal && row.name !== draft.note).map(row => row.name)])]
                        : draft.names.filter(name => !group.skills.some(row => row.name === name)),
                    })
                  }
                >
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    {t('Select group {name}', { name: group.name })}
                  </Checkbox.Content>
                </Checkbox>
              </>
            ) : null}
            <div className="group-grants-list">
              {group.skills
                .filter(row => !row.internal || draft.showInternal || row.name === draft.note)
                .map(row => (
                  <section className="group-grant-item" key={row.name} aria-label={t('Import candidate {name}', { name: row.name })}>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        isSelected={draft.names.includes(row.name) && row.name !== draft.note}
                        isDisabled={busy || row.name === draft.note}
                        onChange={checked =>
                          onChange({ ...draft, names: checked ? [...draft.names, row.name] : draft.names.filter(name => name !== row.name) })
                        }
                      >
                        <Checkbox.Content>
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                          {row.name}
                        </Checkbox.Content>
                      </Checkbox>
                      {row.internal ? (
                        <Chip size="sm" variant="soft">
                          {t('Internal skill')}
                        </Chip>
                      ) : null}
                    </div>
                    <p>{row.description}</p>
                    {row.change ? (
                      <Chip size="sm" variant="soft">
                        {t(row.change === 'changed' ? 'Changed skill' : row.change === 'added' ? 'New skill' : 'Unchanged skill')}
                      </Chip>
                    ) : null}
                    {row.source ? (
                      <p className="break-all">
                        {row.source.url} · {row.source.path} · <code>{row.source.commit}</code>
                      </p>
                    ) : null}
                    {row.replacing ? (
                      <>
                        <CommunityMessage status="warning" title={t('Changes apply to new sessions. Running tasks using this skill may fail.')} />
                        <p>{t('{managed} managed members · {selected} member selections', { managed: row.managedMembers, selected: row.selectedMembers })}</p>
                        <Checkbox
                          isSelected={draft.replacements.includes(row.name)}
                          isDisabled={busy || !draft.names.includes(row.name)}
                          onChange={checked =>
                            onChange({
                              ...draft,
                              replacements: checked ? [...draft.replacements, row.name] : draft.replacements.filter(name => name !== row.name),
                            })
                          }
                        >
                          <Checkbox.Content>
                            <Checkbox.Control>
                              <Checkbox.Indicator />
                            </Checkbox.Control>
                            {t('Replace existing {name}', { name: row.name })}
                          </Checkbox.Content>
                        </Checkbox>
                      </>
                    ) : null}
                    {row.warnings.length ? (
                      <CommunityMessage status="warning" title={t('Possible credentials in this skill. Review before sharing.')}>
                        {row.warnings.map(warning => (
                          <p key={warning.path + warning.kind}>
                            <code>{warning.path}</code> · {t(warning.kind === 'filename' ? 'Sensitive filename' : 'Possible secret content')}
                          </p>
                        ))}
                      </CommunityMessage>
                    ) : null}
                    <details open={preview.candidates.length === 1}>
                      <summary>{t('Skill contents')}</summary>
                      <CommunitySkillContent markdown={row.markdown} files={row.files} />
                    </details>
                  </section>
                ))}
            </div>
          </section>
        ))}
      {preview.deleted?.length ? (
        <section className="page-stack">
          <h3>{t('Deleted from source')}</h3>
          <p>{t('Select only the skills you want to remove from the library.')}</p>
          {preview.deleted.map(row => (
            <div key={row.name}>
              <Checkbox
                isSelected={draft.removals.includes(row.name)}
                isDisabled={busy}
                onChange={checked =>
                  onChange({ ...draft, removals: checked ? [...draft.removals, row.name] : draft.removals.filter(name => name !== row.name) })
                }
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  {t('Remove missing {name}', { name: row.name })}
                </Checkbox.Content>
              </Checkbox>
              {row.packs.length ? (
                <p>
                  {t('Affected skill packs')}: {row.packs.join(', ')}
                </p>
              ) : null}
              <p>{t('{managed} managed members · {selected} member selections', { managed: row.managedMembers, selected: row.selectedMembers })}</p>
            </div>
          ))}
        </section>
      ) : null}
      <section className="page-stack" aria-label={t('Create packs during import')}>
        {draft.packs.map((pack, index) => (
          <div className="page-stack" key={index}>
            <Checkbox
              isSelected={pack.enabled}
              isDisabled={busy}
              onChange={enabled => onChange({ ...draft, packs: draft.packs.map((row, i) => (i === index ? { ...row, enabled } : row)) })}
            >
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                {preview.packs.length ? t('Create suggested pack {name}', { name: pack.name }) : t('Also create a skill pack')}
              </Checkbox.Content>
            </Checkbox>
            {pack.enabled ? (
              <>
                <CommunityField
                  label={t('Pack name')}
                  value={pack.name}
                  disabled={busy}
                  onChange={name => onChange({ ...draft, packs: draft.packs.map((row, i) => (i === index ? { ...row, name } : row)) })}
                />
                <CommunityField
                  label={t('Pack description')}
                  value={pack.description}
                  disabled={busy}
                  onChange={description => onChange({ ...draft, packs: draft.packs.map((row, i) => (i === index ? { ...row, description } : row)) })}
                />
              </>
            ) : null}
          </div>
        ))}
      </section>
    </div>
  )
}
