import { publishCommunitySkillPack } from './community-publication-api'
import CommunityPublicationSection from './CommunityPublicationSection'
import { featureVisible } from '../../src/domain/release-visibility'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Checkbox } from '@heroui/react/checkbox'
import { TextField } from '@heroui/react/textfield'
import { TextArea } from '@heroui/react/textarea'
import { Label } from '@heroui/react/label'
import type { CommunitySkillPackInput, CommunitySkillPackDetail } from '../../src/domain/admin-contract'
import { communitySkillPacks, communitySkillPackDetail } from './community-api'
import { saveCommunitySkillPack, saveCommunitySkillPackDisplay, removeCommunitySkillPack } from './community-skill-pack-api'
import { usePlatformLanguage } from './CommunityLanguage'
import { useDraftGuard } from './useDraftGuard'
import CommunityDialog from './CommunityDialog'
import CommunityField from './CommunityField'
import CommunityMessage from './CommunityMessage'
import CommunitySkillPackPicker from './CommunitySkillPackPicker'
import type { CommunitySkillPackMember } from '../../src/domain/skill-admin-contract'

const blank: CommunitySkillPackInput = { name: '', description: '', skills: [], instructions: '', published: false }
const input = (row: CommunitySkillPackInput): CommunitySkillPackInput => ({
  name: row.name,
  description: row.description,
  skills: row.skills,
  instructions: row.instructions,
  published: row.published,
})
export default function CommunitySkillPackEditor({ name, onClose, onSaved }: { name: string; onClose: () => void; onSaved: () => void }) {
  const { t, errorText } = usePlatformLanguage()
  const [draft, setDraft] = useState<CommunitySkillPackInput>(blank),
    [saved, setSaved] = useState<CommunitySkillPackInput>(blank)
  const [displayName, setDisplayName] = useState('')
  const [members, setMembers] = useState<readonly CommunitySkillPackMember[]>([])
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [picking, setPicking] = useState(false)
  const [reload, setReload] = useState(0)
  const [revision, setRevision] = useState(''),
    [detail, setDetail] = useState<CommunitySkillPackDetail>()
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [removing, setRemoving] = useState(false),
    [deleteSkills, setDeleteSkills] = useState(false)
  const [confirmation, setConfirmation] = useState<CommunitySkillPackDetail>()
  const pending = useRef(false)
  const readOnly = !!detail?.suiteOrigin
  useEffect(() => {
    const controller = new AbortController()
    const request = name ? communitySkillPackDetail(name, controller.signal) : communitySkillPacks(controller.signal)
    void request
      .then(value => {
        if (controller.signal.aborted) return
        setError(undefined)
        setRevision(value.revision)
        if ('name' in value) {
          setMembers(value.members)
          setDetail(value)
          setDisplayName(value.displayName ?? value.name)
          setDraft(input(value))
          setSaved(input(value))
        }
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    return () => controller.abort()
  }, [name, reload])
  const savedDisplayName = detail?.displayName ?? name
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || (readOnly && displayName !== savedDisplayName)
  const discard = () => {
    setDraft(saved)
    setDisplayName(savedDisplayName)
  }
  const save = async () => {
    if (pending.current || !revision) return false
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      if (readOnly) {
        await saveCommunitySkillPackDisplay(
          name,
          {
            ...(displayName !== savedDisplayName ? { displayName } : {}),
            ...(draft.description !== saved.description ? { description: draft.description } : {}),
          },
          revision,
        )
      } else await saveCommunitySkillPack(draft, revision, name || undefined)
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
  const guard = useDraftGuard(dirty, save, discard, busy)
  const remove = async () => {
    if (!detail || pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      await removeCommunitySkillPack(name, deleteSkills, detail.revision)
      onSaved()
    } catch (failure) {
      setError(failure)
      setRemoving(false)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const reviewPublication = async () => {
    if (!detail || pending.current || dirty) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      setConfirmation(await communitySkillPackDetail(detail.name))
    } catch (failure) {
      setError(failure)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const publish = async () => {
    if (!confirmation || pending.current || dirty) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      await publishCommunitySkillPack(confirmation.name, !confirmation.published, confirmation.revision)
      const next = await communitySkillPackDetail(confirmation.name)
      setDetail(next)
      setMembers(next.members)
      setDisplayName(next.displayName ?? next.name)
      setDraft(input(next))
      setSaved(input(next))
      setRevision(next.revision)
    } catch (failure) {
      setError(failure)
    } finally {
      setConfirmation(undefined)
      pending.current = false
      setBusy(false)
    }
  }
  const move = (index: number, direction: number) => {
    const names = [...draft.skills]
    ;[names[index], names[index + direction]] = [names[index + direction]!, names[index]!]
    setDraft({ ...draft, skills: names })
  }
  const byName = new Map(members.map(row => [row.name, row]))
  const term = search.trim().toLowerCase()
  const visible = draft.skills
    .map((name, index) => ({ name, index, row: byName.get(name) }))
    .filter(({ name, row }) => name.toLowerCase().includes(term) || row?.description.toLowerCase().includes(term))
  const pageSize = 12
  const currentPage = Math.min(page, Math.max(0, Math.ceil(visible.length / pageSize) - 1))
  return (
    <>
      <CommunityDialog
        drawer
        drawerClassName="plugin-drawer library-form-drawer catalog-form-drawer"
        title={detail?.displayName ?? (name || t('Create skill pack'))}
        closeLabel={t('Close skill pack details')}
        busy={busy}
        onClose={() => guard.request(onClose)}
        footer={
          <>
            <Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(onClose)}>
              {t('Cancel')}
            </Button>
            <Button
              isDisabled={busy || !revision || !dirty || !(readOnly ? displayName : draft.name).trim() || !draft.description.trim()}
              onPress={() => {
                void save()
              }}
            >
              {t('Save skill pack')}
            </Button>
          </>
        }
      >
        {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
        {!revision ? (
          error ? (
            <Button variant="secondary" onPress={() => setReload(value => value + 1)}>
              {t('Reload skill packs')}
            </Button>
          ) : (
            <p role="status">{t('Loading…')}</p>
          )
        ) : (
          <div className="plugin-access-template">
            <CommunityPublicationSection
              published={detail?.published ?? false}
              unavailable={!!detail?.unavailable}
              reason={
                detail?.unavailable
                  ? t(
                      detail.unavailable === 'empty'
                        ? 'Empty packs are temporarily unavailable to members.'
                        : 'All pack skills conflict with the runtime and are temporarily unavailable.',
                    )
                  : undefined
              }
            >
              <p>{t('Publishing lets all members select this resource when it is available.')}</p>
              <p>{t('Unpublishing clears selections of this pack. Group grants and individual skill selections are kept.')}</p>
              <p>{t('Republishing does not restore removed member selections.')}</p>
              {detail ? (
                <>
                  <Button
                    variant="secondary"
                    isDisabled={busy || dirty}
                    onPress={() => {
                      void reviewPublication()
                    }}
                  >
                    {t(detail.published ? 'Unpublish resource' : 'Publish resource')}
                  </Button>
                  {dirty ? (
                    <>
                      <p>{t('Save or discard changes before publishing.')}</p>
                      <Button variant="tertiary" isDisabled={busy} onPress={discard}>
                        {t('Discard changes')}
                      </Button>
                    </>
                  ) : null}
                </>
              ) : (
                <p>{t('Save this resource before publishing.')}</p>
              )}
            </CommunityPublicationSection>

            {readOnly ? (
              <section className="plugin-detail-section">
                <p>{t('Catalog source {name}', { name: detail!.suiteOrigin!.replace(/^suite:/u, '') })}</p>
                <CommunityField label={t('Pack name')} value={name} readOnly />
              </section>
            ) : null}
            <CommunityField
              label={t(readOnly ? 'Pack display name' : 'Pack name')}
              value={readOnly ? displayName : draft.name}
              description={readOnly ? t(detail?.displayOverrides?.includes('displayName') ? 'Local override' : 'Uses catalog value') : undefined}
              disabled={busy}
              onChange={value => (readOnly ? setDisplayName(value) : setDraft({ ...draft, name: value }))}
              required
            />
            <CommunityField
              label={t('Pack description')}
              value={draft.description}
              description={readOnly ? t(detail?.displayOverrides?.includes('description') ? 'Local override' : 'Uses catalog value') : undefined}
              disabled={busy}
              onChange={value => setDraft({ ...draft, description: value })}
              required
            />
            <section className="plugin-detail-section" aria-label={t('Pack skills')}>
              <div className="plugin-section-heading">
                <h3>
                  {t('Pack skills')} · {t('{count} skills', { count: draft.skills.length })}
                </h3>
                {readOnly ? null : (
                  <Button size="sm" variant="secondary" isDisabled={busy || draft.skills.length >= 256} onPress={() => setPicking(true)}>
                    {t('Add skills')}
                  </Button>
                )}
              </div>
              {draft.skills.length ? (
                <CommunityField
                  label={t('Search pack skills')}
                  value={search}
                  onChange={value => {
                    setSearch(value)
                    setPage(0)
                  }}
                />
              ) : (
                <p>{t('This pack has no skills.')}</p>
              )}
              {draft.skills.length && !visible.length ? <p>{t('No skills match this filter.')}</p> : null}
              <ol className="grant-rows">
                {visible.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(({ name, row, index }) => (
                  <li key={name}>
                    <div className="grant-row-main">
                      <strong>
                        {index + 1}. {name}
                      </strong>
                      {row?.description ? <p>{row.description}</p> : null}
                      {!row || row.conflict ? <p>{t('Skill is unavailable.')}</p> : null}
                    </div>
                    {readOnly ? null : (
                      <div className="catalog-entry-actions">
                        <Button
                          size="sm"
                          variant="tertiary"
                          isDisabled={busy || !!term || index === 0}
                          aria-label={t('Move {name} up', { name })}
                          onPress={() => move(index, -1)}
                        >
                          ↑
                        </Button>
                        <Button
                          size="sm"
                          variant="tertiary"
                          isDisabled={busy || !!term || index === draft.skills.length - 1}
                          aria-label={t('Move {name} down', { name })}
                          onPress={() => move(index, 1)}
                        >
                          ↓
                        </Button>
                        <Button
                          size="sm"
                          variant="tertiary"
                          isDisabled={busy}
                          onPress={() => setDraft({ ...draft, skills: draft.skills.filter(skill => skill !== name) })}
                        >
                          {t('Remove skill {name}', { name })}
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
              {visible.length > pageSize ? (
                <div className="catalog-entry-actions">
                  <Button size="sm" variant="secondary" isDisabled={currentPage === 0} onPress={() => setPage(currentPage - 1)}>
                    {t('Previous page')}
                  </Button>
                  <Button size="sm" variant="secondary" isDisabled={(currentPage + 1) * pageSize >= visible.length} onPress={() => setPage(currentPage + 1)}>
                    {t('Next page')}
                  </Button>
                </div>
              ) : null}
            </section>
            <TextField
              value={draft.instructions}
              onChange={value => setDraft({ ...draft, instructions: value })}
              isDisabled={busy}
              isReadOnly={readOnly}
              fullWidth
            >
              <Label>{t('Orchestration instructions (optional)')}</Label>
              <TextArea rows={8} />
            </TextField>
            <p>{t('Instructions become an additional skill named after this pack. The name must be unique.')}</p>
            {name && !readOnly ? (
              <Button variant="danger" isDisabled={busy || dirty} onPress={() => setRemoving(true)}>
                {t('Remove skill pack')}
              </Button>
            ) : null}
          </div>
        )}
      </CommunityDialog>
      {picking ? (
        <CommunitySkillPackPicker
          current={draft.skills}
          onClose={() => setPicking(false)}
          onAdd={rows => {
            setMembers(current => [...current.filter(row => !rows.some(added => added.name === row.name)), ...rows])
            setDraft(current => ({ ...current, skills: [...current.skills, ...rows.map(row => row.name)] }))
            setPicking(false)
          }}
        />
      ) : null}
      {removing && detail ? (
        <CommunityDialog
          title={t('Remove skill pack')}
          busy={busy}
          onClose={() => setRemoving(false)}
          footer={
            <>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setRemoving(false)}>
                {t('Cancel')}
              </Button>
              <Button
                variant="danger"
                isDisabled={busy}
                onPress={() => {
                  void remove()
                }}
              >
                {t('Confirm removal')}
              </Button>
            </>
          }
        >
          {featureVisible('experts') && (deleteSkills ? detail.removal.expertsWithSkills : detail.removal.experts).length ? (
            <p>
              {t('Will be removed from experts: {names}', {
                names: (deleteSkills ? detail.removal.expertsWithSkills : detail.removal.experts).map(row => row.name).join(', '),
              })}
            </p>
          ) : null}
          <p>{t('Only the pack is removed by default. Library skills remain available.')}</p>
          <Checkbox isSelected={deleteSkills} isDisabled={busy} onChange={setDeleteSkills}>
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              {t('Also delete eligible skills')}
            </Checkbox.Content>
          </Checkbox>
          <p>
            {t('Affected groups')}: {detail.removal.groups.map(group => group.name).join(', ') || '—'}
          </p>
          <p>{t('{count} member selections', { count: deleteSkills ? detail.removal.selectedMembersWithSkills : detail.removal.selectedMembers })}</p>
          {deleteSkills ? (
            <>
              <h3>{t('Skills to delete')}</h3>
              <p>{detail.removal.deleting.join(', ') || '—'}</p>
              <h3>{t('Skills to retain')}</h3>
              {detail.removal.retained.map(skill => (
                <p key={skill.name}>
                  {skill.name}: {skill.reasons.map(reason => t(reason === 'other-pack' ? 'Used by another pack' : 'Directly granted to a group')).join(', ')}
                </p>
              ))}
            </>
          ) : null}
          <CommunityMessage status="warning" title={t('Changes apply to new sessions. Running tasks using this skill may fail.')} />
        </CommunityDialog>
      ) : null}
      {confirmation ? (
        <CommunityDialog
          title={t(confirmation.published ? 'Confirm skill pack unpublication' : 'Confirm skill pack publication')}
          busy={busy}
          onClose={() => setConfirmation(undefined)}
          footer={
            <>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setConfirmation(undefined)}>
                {t('Cancel')}
              </Button>
              <Button
                isDisabled={busy}
                onPress={() => {
                  void publish()
                }}
              >
                {t('Confirm')}
              </Button>
            </>
          }
        >
          <p>{t('{count} member selections', { count: confirmation.removal.selectedMembers })}</p>
          <p>
            {t(
              confirmation.published
                ? 'Unpublishing clears selections of this pack. Group grants and individual skill selections are kept.'
                : 'Publishing lets all members select this resource when it is available.',
            )}
          </p>
          {confirmation.hasPlatformCredential ? <p>{t('All members can use the platform credentials through this resource.')}</p> : null}
          <p>{t('Republishing does not restore removed member selections.')}</p>
        </CommunityDialog>
      ) : null}
      {guard.dialog}
    </>
  )
}
