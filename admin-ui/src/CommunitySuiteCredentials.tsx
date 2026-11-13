import { useEffect, useState } from 'react'
import type { CommunitySuiteCatalogEntryView, CommunitySuiteInstallView } from '../../src/domain/admin-contract'
import { saveCommunitySuiteCredentials } from './community-api'
import CommunityField from './CommunityField'
import { filledCredentials } from './community-suite-credentials'
import { Button } from '@heroui/react/button'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityMessage from './CommunityMessage'

export default function CommunitySuiteCredentials({
  entry,
  installation,
  onSaved,
  onDraft,
}: {
  entry: CommunitySuiteCatalogEntryView
  installation: CommunitySuiteInstallView
  onSaved: () => void
  onDraft: (key: string, dirty: boolean, busy: boolean) => void
}) {
  const missing = installation.missingCredentials ?? []
  const configured = installation.execution?.configuredVariables ?? []
  const names = installation.execution?.variables ?? []
  const { t, locale, errorText } = usePlatformLanguage()
  const [values, setValues] = useState<Readonly<Record<string, string>>>({})
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const filled = filledCredentials(values)
  const dirty = Object.keys(filled).length > 0
  useEffect(() => {
    const key = JSON.stringify(['legacy', entry.id])
    onDraft(key, dirty, busy)
    return () => onDraft(key, false, false)
  }, [entry.id, dirty, busy, onDraft])
  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    setSaved(false)
    try {
      await saveCommunitySuiteCredentials(entry.id, filled, { version: installation.version, contentHash: installation.contentHash })
      setValues({})
      setSaved(true)
      onSaved()
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="page-stack" aria-label={t('Team credentials')}>
      <h2>{t('Team credentials')}</h2>
      {missing.length ? (
        <CommunityMessage role="status" status="warning" title={t('Missing credentials')}>
          <p>{t('Delegated execution is off until these credentials are saved: {names}', { names: missing.join(', ') })}</p>
        </CommunityMessage>
      ) : installation.execution?.enabled ? (
        <CommunityMessage role="status" status="success" title={t('Credentials are saved. Delegated execution is on.')} />
      ) : (
        <CommunityMessage role="status" status="warning" title={t('Delegated execution is off. Configure a backend when needed.')} />
      )}
      {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
      {names.map(name => (
        <CommunityField
          key={name}
          label={name}
          type="password"
          autoComplete="new-password"
          value={values[name] ?? ''}
          onChange={value => setValues(current => ({ ...current, [name]: value }))}
          disabled={busy}
          description={
            (configured.includes(name) ? t('A credential is saved. Leave blank to keep it.') + ' ' : '') +
            (entry.version === installation.version ? (entry.execution?.variables.find(variable => variable.name === name)?.purpose[locale] ?? '') : '')
          }
        />
      ))}
      {saved ? <CommunityMessage role="status" status="success" title={t('Credentials saved.')} /> : null}
      <div>
        <Button
          variant="secondary"
          isDisabled={busy || Object.keys(filled).length === 0}
          onPress={() => {
            void submit()
          }}
        >
          {t('Save credentials')}
        </Button>
      </div>
    </section>
  )
}
