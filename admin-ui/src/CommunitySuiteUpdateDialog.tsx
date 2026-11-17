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
        ...(preview.dependencyChanges ?? [])
          .filter(row => row.changed)
          .map(row =>
            t(!row.from ? 'Runtime dependency added: {name}' : !row.to ? 'Runtime dependency removed: {name}' : 'Runtime dependency updated: {name}', {
              name: row.name,
            }),
          ),
        preview.plugin?.modified
          ? t('Administrator access settings are kept.')
          : preview.plugin?.configurationChanged
            ? t('The catalog access template will be applied.')
            : undefined,
        preview.plugin && !preview.plugin.modified && preview.plugin.configurationChanged
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
      ? t('No update is available for this entry.')
      : preview?.reason === 'dependency-missing'
        ? t('Install the shared dependencies this version needs first: {names}', { names: list((preview.missingDependencies ?? []).map(titleOf)) })
        : preview?.reason === 'skill-conflicts'
          ? t('These skills already exist with a different origin: {names}', { names: list(preview.conflicts ?? []) })
          : preview?.reason === 'unavailable-architecture'
            ? t('Unavailable on this architecture')
            : preview?.reason
              ? t('Another task is running for this entry. Try again when it finishes.')
              : undefined
  const plugin = preview?.plugin
  const packageSummary = plugin?.from
    ? plugin.from !== plugin.to
      ? t('Plugin {name}: {from} → {to}', { name: plugin.packageName, from: plugin.from, to: plugin.to })
      : plugin.artifactChanged
        ? t('Plugin package contents have changed.')
        : plugin.artifactChanged === false && (plugin.configurationChanged || preview?.dependencyChanges?.some(row => row.changed))
          ? t('The plugin version is unchanged. Configuration or runtime dependencies have changed.')
          : undefined
    : undefined
  return (
    <CommunityDialog
      title={entry.title[locale]}
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
          {blocked ? (
            <CommunityMessage role="alert" status="warning" title={blocked} />
          ) : (
            <p>{packageSummary ?? t('An update is available for this entry.')}</p>
          )}
          {!blocked && !plugin?.from && entry.category === 'plugin' && !preview.skipped.some(row => row.kind === 'plugin') ? (
            <p>
              {t('Installed version unknown')}
              {plugin ? ` · ${t('Catalog target version {version}', { version: plugin.to })}` : ''}
            </p>
          ) : null}
          {lines.length ? (
            <ul>
              {lines.map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          <p>{t('Saved credentials, grants, publication and member selections are kept. If any step fails, the current version stays in use.')}</p>
        </>
      )}
    </CommunityDialog>
  )
}
