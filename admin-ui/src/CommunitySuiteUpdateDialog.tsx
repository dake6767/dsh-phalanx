import { useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import type { CommunitySuiteCatalogEntryView, CommunitySuiteUpdatePreview } from '../../src/domain/admin-contract'
import { communitySuiteUpdatePreview, updateCommunitySuite } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityDialog from './CommunityDialog'
import CommunityMessage from './CommunityMessage'

/** Lists what an update changes; nothing changes until the administrator confirms. */
export default function CommunitySuiteUpdateDialog({
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
  const [preview, setPreview] = useState<CommunitySuiteUpdatePreview>()
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    void communitySuiteUpdatePreview(entry.id, controller.signal)
      .then(setPreview)
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    return () => controller.abort()
  }, [entry.id])
  const submit = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      await updateCommunitySuite(entry.id)
      onSubmitted()
    } catch (failure) {
      setError(failure)
      setBusy(false)
    } finally {
      pending.current = false
    }
  }
  const list = (names: readonly string[]) => names.join(', ')
  const lines = preview
    ? [
        ...(preview.dependencyChanges ?? []).map(row =>
          t('Dependency {name}: catalog {from} → {to}', { name: row.name, from: row.from || '—', to: row.to || '—' }),
        ),
        preview.plugin ? t('Plugin {name}: {from} → {to}', { name: preview.plugin.packageName, from: preview.plugin.from, to: preview.plugin.to }) : undefined,
        preview.plugin ? t(preview.plugin.modified ? 'Administrator access settings are kept.' : 'The catalog access template will be applied.') : undefined,
        preview.plugin
          ? t('Access template changes: {names}', {
              names:
                [
                  ...preview.plugin.access.added.map(row => '+' + row.name),
                  ...preview.plugin.access.removed.map(row => '-' + row.name),
                  ...preview.plugin.access.changed.map(row => row.name),
                  ...(preview.plugin.access.entriesChanged ? ['entries'] : []),
                ].join(', ') || '—',
            })
          : undefined,
        preview.dependency
          ? t(
              preview.dependency.changed
                ? 'Runtime dependency {name}: a new version is prepared and checked before it replaces the current one, which is kept as the previous version.'
                : 'Runtime dependency {name}: unchanged',
              { name: preview.dependency.name },
            )
          : undefined,
        preview.skills.added.length ? t('Skills added: {names}', { names: list(preview.skills.added) }) : undefined,
        preview.skills.updated.length ? t('Skills updated: {names}', { names: list(preview.skills.updated) }) : undefined,
        preview.skills.removed.length ? t('Skills removed, with their grants and selections: {names}', { names: list(preview.skills.removed) }) : undefined,
        preview.pack && (preview.pack.added.length || preview.pack.removed.length)
          ? t('Skill pack {name}: adds {added}; removes {removed}', {
              name: preview.pack.name,
              added: list(preview.pack.added) || '—',
              removed: list(preview.pack.removed) || '—',
            })
          : undefined,
        preview.execution?.commands.added.length ? t('Delegated commands added: {names}', { names: list(preview.execution.commands.added) }) : undefined,
        preview.execution?.commands.removed.length ? t('Delegated commands removed: {names}', { names: list(preview.execution.commands.removed) }) : undefined,
        preview.execution?.commands.changed.length
          ? t('Blocked first arguments changed: {names}', { names: list(preview.execution.commands.changed) })
          : undefined,
        preview.execution?.variables.added.length
          ? t('New credentials: {names}. Delegated execution stays off until they are saved.', { names: list(preview.execution.variables.added) })
          : undefined,
        preview.execution?.variables.removed.length
          ? t('Credentials no longer used: {names}', { names: list(preview.execution.variables.removed) })
          : undefined,
        preview.dependents.length ? t('Tools using this dependency: {names}', { names: list(preview.dependents.map(titleOf)) }) : undefined,
        preview.skipped.length ? t('Not updated (detached from the tool): {names}', { names: list(preview.skipped.map(row => row.name)) }) : undefined,
        preview.manualDependencies.length
          ? t('Not updated (your manual dependency): {names}', { names: list(preview.manualDependencies.map(row => row.name)) })
          : undefined,
      ].filter((line): line is string => line !== undefined)
    : []
  const blocked =
    preview?.reason === 'up-to-date'
      ? t('This entry already has the catalog version.')
      : preview?.reason === 'dependency-missing'
        ? t('Install the shared dependencies this version needs first: {names}', { names: list((preview.missingDependencies ?? []).map(titleOf)) })
        : preview?.reason === 'skill-conflicts'
          ? t('These skills already exist with a different origin: {names}', { names: list(preview.conflicts ?? []) })
          : preview?.reason === 'unavailable-architecture'
            ? t('Unavailable on this architecture')
            : preview?.reason
              ? t('Another task is running for this entry. Try again when it finishes.')
              : undefined
  return (
    <CommunityDialog
      title={entry.title[locale]}
      eyebrow={t('Update preview')}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="tertiary" isDisabled={busy} onPress={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            isDisabled={busy || preview === undefined || blocked !== undefined}
            onPress={() => {
              void submit()
            }}
          >
            {t('Confirm update')}
          </Button>
        </>
      }
    >
      {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
      {preview === undefined ? (
        <p role="status">{t('Loading…')}</p>
      ) : (
        <>
          <p>{t('Version {from} → {to}', { from: preview.from, to: preview.to })}</p>
          {blocked ? <CommunityMessage role="alert" status="warning" title={blocked} /> : null}
          <ul>{lines.length ? lines.map(line => <li key={line}>{line}</li>) : <li>{t('No changes')}</li>}</ul>
          <p>{t('Saved credentials, grants, publication and member selections are kept. If any step fails, the current version stays in use.')}</p>
        </>
      )}
    </CommunityDialog>
  )
}
