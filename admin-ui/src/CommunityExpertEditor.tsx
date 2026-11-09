import { useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Chip } from '@heroui/react/chip'
import { TextField } from '@heroui/react/textfield'
import { TextArea } from '@heroui/react/textarea'
import { Label } from '@heroui/react/label'
import type { CommunityExpertInput, CommunityExpertLibrary, CommunitySkillView, CommunitySkillPackView } from '../../src/domain/admin-contract'
import { communitySkills, communitySkillPacks, saveCommunityExpert } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import { useDraftGuard } from './useDraftGuard'
import CommunityDialog from './CommunityDialog'
import CommunityField from './CommunityField'
import CommunityMessage from './CommunityMessage'
import CommunitySelect from './CommunitySelect'
import CommunityGrantList from './CommunityGrantList'
import CommunityGrantSection from './CommunityGrantSection'

const blank: CommunityExpertInput = { name: '', description: '', icon: '✦', persona: '', skills: [], skillPacks: [], plugins: [], mcp: [], examples: [] }
export default function CommunityExpertEditor({
  expert,
  plugins,
  mcp,
  models,
  revision,
  onClose,
  onSaved,
  publishing = false,
  onPublish,
  onRemove,
}: {
  expert?: CommunityExpertLibrary['experts'][number]
  plugins: CommunityExpertLibrary['plugins']
  mcp: CommunityExpertLibrary['mcp']
  models: CommunityExpertLibrary['models']
  revision: string
  onClose: () => void
  onSaved: () => void
  publishing?: boolean
  onPublish?: (published: boolean) => Promise<unknown>
  onRemove?: () => void
}) {
  const { t, errorText } = usePlatformLanguage()
  const initial: CommunityExpertInput = expert
    ? {
        name: expert.name,
        description: expert.description,
        icon: expert.icon,
        persona: expert.persona,
        skills: expert.skills,
        skillPacks: expert.skillPacks,
        plugins: expert.plugins,
        mcp: expert.mcp,
        model: expert.model,
        reasoningEffort: expert.reasoningEffort,
        examples: expert.examples,
      }
    : blank
  const [draft, setDraft] = useState(initial),
    [skills, setSkills] = useState<readonly CommunitySkillView[]>(),
    [packs, setPacks] = useState<readonly CommunitySkillPackView[]>([])
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>()
  const pending = useRef(false),
    saved = useRef(initial),
    baseRevision = useRef(revision)
  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([communitySkills(controller.signal), communitySkillPacks(controller.signal)])
      .then(([skills, packs]) => {
        if (!controller.signal.aborted) {
          setSkills(skills)
          setPacks(packs.packs)
        }
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    return () => controller.abort()
  }, [])
  const pluginOptions = [
    ...plugins,
    ...(draft.plugins ?? [])
      .filter(name => !plugins.some(row => row.packageName === name))
      .map(packageName => ({ packageName, title: t('Unavailable saved entry'), eligible: false })),
  ]
  const mcpOptions = [
    ...mcp,
    ...(draft.mcp ?? []).filter(name => !mcp.some(row => row.name === name)).map(name => ({ name, description: t('Unavailable saved entry') })),
  ]
  const skillOptions = [
    ...(skills ?? []),
    ...draft.skills.filter(name => !skills?.some(row => row.name === name)).map(name => ({ name, description: t('Unavailable saved entry'), topLevel: true })),
  ]
  const packOptions = [
    ...packs,
    ...draft.skillPacks
      .filter(name => !packs.some(row => row.name === name))
      .map(name => ({ name, description: t('Unavailable saved entry'), skills: [] as readonly string[] })),
  ]
  const packRows = packOptions.map(pack => ({
    id: `pack:${pack.name}`,
    name: pack.name,
    meta: t('Skill pack · {count} skills', { count: pack.skills.length }),
  }))
  const skillRows = skillOptions.map(skill => ({
    id: skill.name,
    name: skill.name,
    meta: skill.topLevel
      ? undefined
      : t('In skill pack {name}', {
          name: packOptions
            .filter(pack => pack.skills.includes(skill.name))
            .map(pack => pack.name)
            .join(', '),
        }),
  }))
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved.current)
  const save = async () => {
    if (pending.current || !skills) return false
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      await saveCommunityExpert(draft, baseRevision.current, expert?.id)
      onSaved()
      return true
    } catch (failure) {
      setError(failure)
      return false
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const guard = useDraftGuard(dirty, save, () => setDraft(saved.current), busy)
  return (
    <>
      <CommunityDialog
        drawer
        drawerClassName="plugin-drawer library-form-drawer"
        title={t(expert ? 'Edit expert' : 'Create expert')}
        closeLabel={t('Close expert details')}
        busy={busy}
        onClose={() => guard.request(onClose)}
        footer={
          <>
            <Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(onClose)}>
              {t('Cancel')}
            </Button>
            <Button
              isDisabled={busy || !skills || !dirty || !draft.name.trim() || !draft.description.trim() || !draft.persona.trim()}
              onPress={() => {
                void save()
              }}
            >
              {t('Save expert')}
            </Button>
          </>
        }
      >
        {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
        <div className="plugin-settings-panel expert-editor">
          <CommunityGrantSection title={t('Basic information')}>
            <CommunityField label={t('Expert name')} value={draft.name} disabled={busy} onChange={name => setDraft({ ...draft, name })} required />
            <CommunityField
              label={t('Expert description')}
              value={draft.description}
              disabled={busy}
              onChange={description => setDraft({ ...draft, description })}
              required
            />
            <CommunityField label={t('Expert icon')} value={draft.icon} disabled={busy} onChange={icon => setDraft({ ...draft, icon })} />
          </CommunityGrantSection>
          <CommunityGrantSection
            title={t('Persona and model')}
            description={t('Every expert includes the standard file, terminal, search and subagent tools.')}
          >
            <CommunitySelect
              label={t('Expert model')}
              disabled={busy}
              value={
                draft.model ? (models.find(row => row.providerId === draft.model?.providerId && row.name === draft.model.name)?.id ?? 'unavailable') : 'default'
              }
              options={[
                { id: 'default', label: t('Host default model') },
                ...models.map(row => ({ id: row.id, label: row.label })),
                ...(draft.model && !models.some(row => row.providerId === draft.model?.providerId && row.name === draft.model.name)
                  ? [{ id: 'unavailable', label: t('Unavailable expert model'), disabled: true }]
                  : []),
              ]}
              onChange={id => {
                const model = models.find(row => row.id === id)
                setDraft({ ...draft, model: model ? { providerId: model.providerId, name: model.name } : null, reasoningEffort: null })
              }}
            />
            {models.find(row => row.providerId === draft.model?.providerId && row.name === draft.model.name)?.reasoning ? (
              <CommunitySelect
                label={t('Expert reasoning effort')}
                disabled={busy}
                value={draft.reasoningEffort ?? ''}
                options={[{ id: '', label: t('Follow member selection') }, ...['off', 'low', 'medium', 'high'].map(id => ({ id, label: id }))]}
                onChange={value => setDraft({ ...draft, reasoningEffort: value || null })}
              />
            ) : null}
            {expert?.reasoningUnavailable ? (
              <CommunityMessage status="warning" title={t('Saved reasoning effort is unavailable and will be ignored.')} />
            ) : null}
            {expert?.modelUnavailable ? (
              <CommunityMessage status="warning" title={t('Expert model is unavailable. New conversations use the host default.')} />
            ) : null}
            <TextField value={draft.persona} onChange={persona => setDraft({ ...draft, persona })} isDisabled={busy} isRequired fullWidth>
              <Label>{t('Expert persona')}</Label>
              <TextArea rows={8} />
            </TextField>
            <TextField
              value={(draft.examples ?? []).join('\n')}
              onChange={value => setDraft({ ...draft, examples: value ? value.split('\n') : [] })}
              isDisabled={busy}
              fullWidth
            >
              <Label>{t('Example tasks (optional, 2–3 lines)')}</Label>
              <TextArea rows={3} />
            </TextField>
          </CommunityGrantSection>
          <CommunityGrantSection title={t('Expert skills')}>
            {skills ? (
              <CommunityGrantList
                rows={[...packRows, ...skillRows]}
                selected={[...draft.skillPacks.map(name => `pack:${name}`), ...draft.skills]}
                candidates={[...packRows, ...skillRows.filter(row => !row.meta), ...skillRows.filter(row => row.meta)].filter(
                  row => !(row.id.startsWith('pack:') ? draft.skillPacks.includes(row.id.slice(5)) : draft.skills.includes(row.id)),
                )}
                onChange={ids =>
                  setDraft({
                    ...draft,
                    skillPacks: ids.filter(id => id.startsWith('pack:')).map(id => id.slice(5)),
                    skills: ids.filter(id => !id.startsWith('pack:')),
                  })
                }
                busy={busy}
                addLabel={t('Add skills')}
                dialogTitle={t('Add skills')}
                emptyLabel={t('No granted skills')}
                noCandidatesLabel={t('No skills available to add')}
                revokeLabel={t('Remove')}
              />
            ) : (
              <p role="status">{t('Loading…')}</p>
            )}
          </CommunityGrantSection>
          <CommunityGrantSection
            title={t('Expert plugins')}
            description={t('Unavailable plugins and plugins that change core entries cannot be included in an expert.')}
          >
            <CommunityGrantList
              rows={pluginOptions.map(row => ({ id: row.packageName, name: row.packageName, meta: row.title, locked: !row.eligible }))}
              selected={draft.plugins ?? []}
              onChange={next => setDraft({ ...draft, plugins: [...next] })}
              busy={busy}
              addLabel={t('Add plugins')}
              dialogTitle={t('Expert plugins')}
              emptyLabel={t('No configured plugins')}
              noCandidatesLabel={t('No available plugins to add')}
              revokeLabel={t('Remove')}
            />
          </CommunityGrantSection>
          <CommunityGrantSection title={t('Expert MCP services')}>
            <CommunityGrantList
              rows={mcpOptions.map(row => ({ id: row.name, name: row.name }))}
              selected={draft.mcp ?? []}
              onChange={next => setDraft({ ...draft, mcp: [...next] })}
              busy={busy}
              addLabel={t('Add MCP services')}
              dialogTitle={t('Expert MCP services')}
              emptyLabel={t('No granted MCP services')}
              noCandidatesLabel={t('No MCP services available to add')}
              revokeLabel={t('Remove')}
            />
          </CommunityGrantSection>
          {expert ? (
            <CommunityGrantSection
              title={t('Publication')}
              description={
                <>
                  <p>{t('Members see published experts in the Platform App Center once their group is granted.')}</p>
                  <p>{t('Expert changes take effect after members restart their instances.')}</p>
                </>
              }
              action={
                <Chip size="sm" variant="soft" color={expert.published ? 'success' : 'default'}>
                  {t(expert.published ? 'Published expert' : 'Unpublished expert')}
                </Chip>
              }
            >
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={busy || publishing || dirty}
                  aria-label={t(expert.published ? 'Unpublish expert {name}' : 'Publish expert {name}', { name: expert.name })}
                  onPress={() => {
                    void onPublish?.(!expert.published)
                  }}
                >
                  {t(expert.published ? 'Unpublish expert' : 'Publish expert')}
                </Button>
              </div>
              {dirty ? <p className="section-note">{t('Save changes before publishing.')}</p> : null}
            </CommunityGrantSection>
          ) : (
            <p className="section-note">{t('Creating an expert does not publish it or grant it to any group.')}</p>
          )}
          {expert && (expert.missing.length || expert.failures.length) ? (
            <CommunityGrantSection title={t('Unavailable entries')}>
              {expert.missing.length ? <p>{expert.missing.join(', ')}</p> : null}
              {expert.failures.map(failure => (
                <CommunityMessage status="danger" key={failure.username} title={t('Expert load failed for {name}', { name: failure.username })} />
              ))}
            </CommunityGrantSection>
          ) : null}
          {expert ? (
            <section className="plugin-detail-section plugin-removal" aria-label={t('Delete expert')}>
              <div className="plugin-section-heading">
                <h2>{t('Delete expert')}</h2>
                <Button size="sm" variant="danger" isDisabled={busy} aria-label={t('Delete expert {name}', { name: expert.name })} onPress={() => onRemove?.()}>
                  {t('Delete expert')}
                </Button>
              </div>
              <p className="section-note">{t('Delete this expert from the library.')}</p>
            </section>
          ) : null}
        </div>
      </CommunityDialog>
      {guard.dialog}
    </>
  )
}
