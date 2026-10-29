import { useEffect, useRef, useState } from 'react'
import { Checkbox } from '@heroui/react/checkbox'
import type { CommunityGroupView, CommunitySuiteCatalogEntryView, CommunitySuiteInstallPreview } from '../../src/domain/admin-contract'
import { communityGroups, communitySuiteInstallPreview, installCommunitySuite } from './community-api'
import CommunityField from './CommunityField'
import CommunityDialog from './CommunityDialog'
import { communityRequestId } from './community-request-id'
import { suiteKindLabels as kindLabels } from './community-suite-labels'
import { filledCredentials } from './community-suite-credentials'
import { Button } from '@heroui/react/button'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityMessage from './CommunityMessage'

export default function CommunitySuiteInstallDialog({
  entry,
  titleOf,
  onClose,
  onSubmitted,
}: {
  entry: CommunitySuiteCatalogEntryView
  titleOf: (id: string) => string
  onClose: () => void
  onSubmitted: () => void
}) {
  const { t, locale, errorText } = usePlatformLanguage()
  const [preview, setPreview] = useState<CommunitySuiteInstallPreview>()
  const [groups, setGroups] = useState<readonly CommunityGroupView[]>()
  const [granted, setGranted] = useState<readonly string[]>([])
  const [publish, setPublish] = useState(false)
  const [credentials, setCredentials] = useState<Readonly<Record<string, string>>>({})
  const [replace, setReplace] = useState(false)
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const [requestId] = useState(communityRequestId)
  const pending = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    void communitySuiteInstallPreview(entry.id, controller.signal)
      .then(setPreview)
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    if (entry.category === 'suite')
      void communityGroups(controller.signal)
        .then(setGroups)
        .catch(() => {})
    return () => controller.abort()
  }, [entry.id, entry.category])
  const ordinaryGroups = groups?.filter(group => group.kind !== 'admin') ?? []
  const submit = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    const filled = filledCredentials(credentials)
    try {
      await installCommunitySuite({
        id: entry.id,
        requestId,
        ...(granted.length ? { groups: granted } : {}),
        ...(publish ? { publish: true } : {}),
        ...(Object.keys(filled).length ? { credentials: filled } : {}),
        ...(replace && preview?.replacements?.length ? { replace: preview.replacements } : {}),
      })
      onSubmitted()
    } catch (failure) {
      setError(failure)
      setBusy(false)
    } finally {
      pending.current = false
    }
  }
  return (
    <CommunityDialog
      title={entry.title[locale]}
      eyebrow={t('Install preview')}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="tertiary" isDisabled={busy} onPress={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            isDisabled={busy || preview === undefined || preview.creates.length === 0 || (Boolean(preview.replacements?.length) && !replace)}
            onPress={() => {
              void submit()
            }}
          >
            {t('Install entry')}
          </Button>
        </>
      }
    >
      {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
      {preview === undefined ? (
        <p role="status">{t('Loading…')}</p>
      ) : (
        <>
          <p>{t('Catalog version {version}', { version: preview.version })}</p>
          <p>{t('This entry will install:')}</p>
          <ul>
            {preview.creates.map(item => (
              <li key={item.kind + ':' + item.name}>
                {t(kindLabels[item.kind])} · {item.name}
                {item.commands?.length ? ` (${item.commands.join(', ')})` : ''}
                {item.detail ? ` · ${item.detail}` : ''}
              </li>
            ))}
          </ul>
          {preview.dependencies?.length ? (
            <>
              <p>{t('Shared runtime dependencies:')}</p>
              <ul>
                {preview.dependencies.map(row => (
                  <li key={row.id}>
                    {titleOf(row.id)} ·{' '}
                    {row.action === 'manual'
                      ? t('Your manual dependency {name} is used; its version is not pinned', { name: row.name ?? row.id })
                      : t(row.action === 'install' ? 'Installed together with this tool' : 'Already in the library; reused without preparing again')}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {preview.replacements?.length && preview.creates.length ? (
            <div className="page-stack">
              <CommunityMessage role="alert" status="warning" title={t('These manual entries will be replaced by the catalog version:')} />
              <ul>
                {preview.replacements.map(row => (
                  <li key={row.kind + ':' + row.name}>
                    {t(kindLabels[row.kind])} · {row.name}
                  </li>
                ))}
              </ul>
              <p>
                {t(
                  'The catalog takes these entries over under the same names, so their references, group grants, publication and member selections carry over. If the install fails, they stay as they were.',
                )}
              </p>
              <Checkbox isSelected={replace} onChange={setReplace} isDisabled={busy}>
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  {t('Replace these manual entries')}
                </Checkbox.Content>
              </Checkbox>
            </div>
          ) : null}
          {preview.pluginConflicts?.length ? (
            <CommunityMessage
              role="alert"
              status="warning"
              title={t('This plugin package belongs to another catalog entry: {names}', { names: preview.pluginConflicts.join(', ') })}
            />
          ) : null}
          {preview.dependencyConflicts?.length ? (
            <CommunityMessage
              role="alert"
              status="warning"
              title={t('These dependencies already provide the same commands: {names}', { names: preview.dependencyConflicts.join(', ') })}
            />
          ) : null}
          {preview.packConflicts?.length ? (
            <CommunityMessage
              role="alert"
              status="warning"
              title={t('These skill pack names are already used by a manual pack; rename or remove it first: {names}', {
                names: preview.packConflicts.join(', '),
              })}
            />
          ) : null}
          {preview.commandConflicts?.length ? (
            <CommunityMessage
              role="alert"
              status="warning"
              title={t('These commands are already delegated by another skill: {names}', { names: preview.commandConflicts.join(', ') })}
            />
          ) : null}
          {preview.conflicts?.length ? (
            <CommunityMessage
              role="alert"
              status="warning"
              title={t('These skills already exist with a different origin: {names}', { names: preview.conflicts.join(', ') })}
            />
          ) : null}
          <p>{t('Preparation uses your configured download sources and verifies every download.')}</p>
          {entry.identity ? <p>{entry.identity[locale]}</p> : null}
          {entry.execution && preview.creates.length ? (
            <div className="page-stack">
              <h2>{t('Team credentials (optional)')}</h2>
              {entry.execution.variables.map(variable => (
                <CommunityField
                  key={variable.name}
                  label={variable.name}
                  type="password"
                  autoComplete="new-password"
                  value={credentials[variable.name] ?? ''}
                  onChange={value => setCredentials(current => ({ ...current, [variable.name]: value }))}
                  disabled={busy}
                  description={variable.purpose[locale]}
                />
              ))}
              <p>
                {t(
                  entry.execution.variables.some(row => row.optional)
                    ? 'You can skip this step. Configure only the backend you use; unrelated optional settings can stay blank.'
                    : 'You can skip this step. Delegated execution stays off until every credential is saved.',
                )}
              </p>
            </div>
          ) : null}
          {entry.category === 'suite' ? (
            <div className="page-stack">
              <h2>{t('Access and publication (optional)')}</h2>
              {ordinaryGroups.length ? (
                ordinaryGroups.map(group => (
                  <Checkbox
                    key={group.id}
                    isSelected={granted.includes(group.id)}
                    onChange={selected => setGranted(current => (selected ? [...current, group.id] : current.filter(id => id !== group.id)))}
                    isDisabled={busy}
                  >
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      {t('Grant to {name}', { name: group.name })}
                    </Checkbox.Content>
                  </Checkbox>
                ))
              ) : (
                <p>{t('No ordinary groups yet.')}</p>
              )}
              <Checkbox isSelected={publish} onChange={setPublish} isDisabled={busy}>
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  {t('Publish to the platform app center')}
                </Checkbox.Content>
              </Checkbox>
              <p>{t('Both choices are optional and can be changed later.')}</p>
            </div>
          ) : null}
          <p>{t('Installing an entry does not grant it to groups or publish it.')}</p>
        </>
      )}
    </CommunityDialog>
  )
}
