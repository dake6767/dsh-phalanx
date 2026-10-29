import { useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Checkbox } from '@heroui/react/checkbox'
import type { CommunitySuiteCatalogEntryView, CommunitySuiteUninstallPreview } from '../../src/domain/admin-contract'
import { communitySuiteUninstallPreview, uninstallCommunitySuite } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityDialog from './CommunityDialog'
import CommunityMessage from './CommunityMessage'
import { suiteKindLabels as kindLabels } from './community-suite-labels'

export default function CommunitySuiteUninstallDialog({
  referenceText,
  entry,
  titleOf,
  onClose,
  onSubmitted,
}: {
  referenceText: (reference: { kind: string; name: string }) => string
  entry: CommunitySuiteCatalogEntryView
  titleOf: (id: string) => string
  onClose: () => void
  onSubmitted: () => void
}) {
  const { t, locale, errorText } = usePlatformLanguage()
  const [preview, setPreview] = useState<CommunitySuiteUninstallPreview>()
  const [removeDependencies, setRemoveDependencies] = useState<readonly string[]>([])
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    // Unreferenced shared dependencies are offered for removal and checked by default.
    void communitySuiteUninstallPreview(entry.id, controller.signal)
      .then(value => {
        setPreview(value)
        setRemoveDependencies(value.dependencies.filter(row => !row.references.length).map(row => row.id))
      })
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
      await uninstallCommunitySuite(entry.id, { removeDependencies, ...(preview ? { expertRevision: preview.expertRevision } : {}) })
      onSubmitted()
    } catch (failure) {
      setError(failure)
      setBusy(false)
    } finally {
      pending.current = false
    }
  }
  const blocked = preview?.blocked.some(item => item.references.length > 0) ?? false
  return (
    <CommunityDialog
      title={entry.title[locale]}
      eyebrow={t('Uninstall preview')}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="tertiary" isDisabled={busy} onPress={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="danger"
            isDisabled={busy || preview === undefined || blocked}
            onPress={() => {
              void submit()
            }}
          >
            {t('Confirm uninstall')}
          </Button>
        </>
      }
    >
      {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
      {preview === undefined ? (
        <p role="status">{t('Loading…')}</p>
      ) : (
        <>
          <p>{t('This will remove:')}</p>
          {preview.experts.length ? <p>{t('Will be removed from experts: {names}', { names: preview.experts.map(row => row.name).join(', ') })}</p> : null}
          <ul>
            {preview.removes.length ? (
              preview.removes.map(item => (
                <li key={item.kind + ':' + item.name}>
                  {t(kindLabels[item.kind])} · {item.name}
                </li>
              ))
            ) : (
              <li>—</li>
            )}
          </ul>
          {preview.impact.length ? (
            <>
              <p>{t('Uninstall impact')}</p>
              <ul>
                {preview.impact.map(item => (
                  <li key={item.name}>
                    {item.name} ·{' '}
                    {item.groups.length ? t('Granted to: {groups}', { groups: item.groups.map(group => group.name).join(', ') }) : t('No group grants')} ·{' '}
                    {t(item.published ? 'Published' : 'Not published')} · {t('{count} members selected this pack.', { count: item.selectedMembers })}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {preview.blocked.length ? (
            <CommunityMessage role="alert" status="warning" title={t('Remove these references before deleting the dependency.')}>
              <ul>
                {preview.blocked.flatMap(item =>
                  item.references.map(reference => (
                    <li key={item.name + ':' + reference.kind + ':' + reference.name}>
                      {referenceText(reference)} → {item.name}
                    </li>
                  )),
                )}
              </ul>
            </CommunityMessage>
          ) : null}
          {preview.dependencies.length ? (
            <div className="page-stack">
              <p>{t('Shared runtime dependencies:')}</p>
              {preview.dependencies.map(row =>
                row.references.length ? (
                  <p key={row.id}>
                    {t('{name} stays installed because it is still used by: {references}', {
                      name: titleOf(row.id),
                      references: row.references.map(referenceText).join(', '),
                    })}
                  </p>
                ) : (
                  <Checkbox
                    key={row.id}
                    isSelected={removeDependencies.includes(row.id)}
                    onChange={selected => setRemoveDependencies(current => (selected ? [...current, row.id] : current.filter(id => id !== row.id)))}
                    isDisabled={busy}
                  >
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      {t('Also remove {name}; nothing else uses it', { name: titleOf(row.id) })}
                    </Checkbox.Content>
                  </Checkbox>
                ),
              )}
            </div>
          ) : null}
          <p>{t('Uninstalling removes the entries and their prepared files.')}</p>
        </>
      )}
    </CommunityDialog>
  )
}
