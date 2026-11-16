import CommunityExecutionTrial from './CommunityExecutionTrial'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Chip } from '@heroui/react/chip'
import { Switch } from '@heroui/react/switch'
import { Label } from '@heroui/react/label'
import CommunityExecutionFields, { executionDraft, executionInput } from './CommunityExecutionFields'
import type { CommunityExecutionView } from '../../src/domain/admin-contract'
import { communitySkillExecution, saveCommunitySkillExecution, reprepareCommunitySkillExecution } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import { useDraftGuard } from './useDraftGuard'
import CommunityDependencyPicker from './CommunityDependencyPicker'
import CommunityMessage from './CommunityMessage'
import CommunityInstalledServiceSettings from './CommunityInstalledServiceSettings'

export default function CommunitySkillExecution({
  name,
  onCloseGuard,
}: {
  name: string
  onCloseGuard: (guard: ((action: () => void) => void) | undefined) => void
}) {
  const { t, errorText } = usePlatformLanguage()
  const [saved, setSaved] = useState<CommunityExecutionView>(),
    [enabled, setEnabled] = useState(false)
  const [draft, setDraft] = useState<ReturnType<typeof executionDraft>>({ commandRows: [], variableRows: [] })
  const [dependencies, setDependencies] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(false),
    [error, setError] = useState<unknown>()
  const [serviceDraft, setServiceDraft] = useState(false)
  const [serviceBusy, setServiceBusy] = useState(false)
  const onServiceDraft = useCallback((_key: string, dirty: boolean, busy: boolean) => {
    setServiceDraft(dirty)
    setServiceBusy(busy)
  }, [])
  const [reload, setReload] = useState(0)
  const reloadExecution = () => setReload(value => value + 1)
  const reset = (value: CommunityExecutionView) => {
    setSaved(value)
    setEnabled(value.enabled)
    setDraft(executionDraft(value))
    setDependencies(value.runtimeDependencies ?? [])
  }
  useEffect(() => {
    const controller = new AbortController()
    void communitySkillExecution(name, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) {
          reset(value)
          setError(undefined)
        }
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    return () => controller.abort()
  }, [name, reload])
  const dirty =
    !!saved &&
    (enabled !== saved.enabled ||
      JSON.stringify(executionInput(draft)) !== JSON.stringify(executionInput(executionDraft(saved))) ||
      JSON.stringify(dependencies) !== JSON.stringify(saved.runtimeDependencies ?? []))
  const save = async () => {
    if (busy || !saved) return false
    setBusy(true)
    setError(undefined)
    setNotice(false)
    try {
      const value = await saveCommunitySkillExecution(name, { enabled, ...executionInput(draft), runtimeDependencies: dependencies })
      reset(value)
      setNotice(true)
      return true
    } catch (failure) {
      setError(failure)
      return false
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (saved?.preparation?.stage !== 'preparing') return
    const controller = new AbortController()
    const timer = setInterval(() => {
      void communitySkillExecution(name, controller.signal)
        .then(value => {
          if (!controller.signal.aborted) setSaved(current => (current ? { ...current, preparation: value.preparation } : current))
        })
        .catch(failure => {
          if (!controller.signal.aborted) setError(failure)
        })
    }, 1500)
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [name, saved?.preparation?.stage])
  const reprepare = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const value = await reprepareCommunitySkillExecution(name)
      reset(value)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  const guard = useDraftGuard(
    dirty || serviceDraft,
    saved?.suiteOrigin ? undefined : save,
    () => {
      if (saved) reset(saved)
    },
    busy || serviceBusy,
  )
  useEffect(() => {
    onCloseGuard(guard.request)
    return () => onCloseGuard(undefined)
  }, [onCloseGuard, guard.request])
  const fromCatalog = Boolean(saved?.suiteOrigin)
  return (
    <>
      <section className="plugin-detail-section">
        <div className="plugin-section-heading">
          <h2>{t('Execution status')}</h2>
          {saved && fromCatalog ? (
            <Chip size="sm" variant="soft" color={saved.enabled ? 'success' : 'default'}>
              {t(saved.enabled ? 'Enabled' : 'Disabled')}
            </Chip>
          ) : null}
        </div>
        {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
        {!saved ? (
          <>
            <p role="status">{t('Loading…')}</p>
            <Button variant="secondary" onPress={reloadExecution}>
              {t('Reload skills')}
            </Button>
          </>
        ) : fromCatalog ? (
          <p>{t('Managed by the catalog. Definition is read-only.')}</p>
        ) : (
          <>
            <p>{t('Run delegated commands with platform credentials for members who own this skill.')}</p>
            <Switch isSelected={enabled} onChange={setEnabled} isDisabled={busy}>
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <Label>{t('Enable platform execution')}</Label>
              </Switch.Content>
            </Switch>
          </>
        )}
      </section>
      {saved ? (
        <>
          {fromCatalog && saved.hasInstalledServices ? (
            <CommunityInstalledServiceSettings key={name} kind="execution" name={name} onDraft={onServiceDraft} onChanged={reloadExecution} />
          ) : null}
          {!fromCatalog || saved.commands.length || saved.variables.length || saved.runtimeDependencies?.length ? (
            <section className="plugin-detail-section">
              <h2>{t('Execution rules')}</h2>
              {saved.unavailableCommands?.length ? (
                <CommunityMessage status="warning" title={t('Commands missing from this skill version')}>
                  <p>{saved.unavailableCommands.join(', ')}</p>
                </CommunityMessage>
              ) : null}
              {fromCatalog ? (
                <dl className="catalog-entry-facts">
                  {saved.commands.length ? (
                    <div>
                      <dt>{t('Delegated commands')}</dt>
                      <dd>
                        <ul className="execution-rule-values">
                          {saved.commands.map(row => (
                            <li key={row.command}>
                              <code>{row.command}</code>
                              {row.blocked.length ? <p>{t('Blocked first arguments: {names}', { names: row.blocked.join(' ') })}</p> : null}
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                  ) : null}
                  {saved.variables.length ? (
                    <div>
                      <dt>{t('Credential variables')}</dt>
                      <dd>
                        <ul className="execution-rule-values">
                          {saved.variables.map(row => (
                            <li key={row.name}>
                              <code>{row.name}</code>
                              {' · '}
                              {row.secret ? t(row.configured ? 'Saved credential' : 'No saved credential') : row.value}
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                  ) : null}
                  {saved.runtimeDependencies?.length ? (
                    <div>
                      <dt>{t('Runtime dependencies')}</dt>
                      <dd>{saved.runtimeDependencies.join(', ')}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : (
                <>
                  <p>{t('Suggested names come from static inspection. Review every command, variable and preparation step before saving.')}</p>
                  <CommunityExecutionFields draft={draft} onChange={setDraft} busy={busy} />
                  <CommunityDependencyPicker
                    key={JSON.stringify([saved.runtimeDependencies ?? [], saved.preparation?.stage])}
                    value={dependencies}
                    onChange={setDependencies}
                    disabled={busy}
                  />
                  {notice && !dirty ? <CommunityMessage status="success" title={t('Execution settings saved.')} /> : null}
                  <div>
                    <Button
                      isDisabled={busy || !dirty}
                      onPress={() => {
                        void save()
                      }}
                    >
                      {t('Save execution settings')}
                    </Button>
                  </div>
                </>
              )}
            </section>
          ) : null}
          {saved.preparation || saved.awaitingPreparation ? (
            <section className="plugin-detail-section">
              <h2>{t('Execution preparation')}</h2>
              {saved.preparation ? (
                <CommunityMessage
                  role="status"
                  status={saved.preparation.stage === 'failed' ? 'danger' : saved.preparation.stage === 'ready' ? 'success' : 'accent'}
                  title={t(
                    saved.preparation.stage === 'failed'
                      ? 'Preparation failed'
                      : saved.preparation.stage === 'ready'
                        ? 'Dependencies ready'
                        : 'Preparing dependencies…',
                  )}
                >
                  <time dateTime={new Date(saved.preparation.updatedAt).toISOString()}>{new Date(saved.preparation.updatedAt).toLocaleString()}</time>
                </CommunityMessage>
              ) : null}
              {saved.preparation?.log ? (
                <details>
                  <summary>{t('Preparation log')}</summary>
                  <pre className="plugin-preparation-log">{saved.preparation.log}</pre>
                </details>
              ) : null}
              {saved.awaitingPreparation ? (
                <div>
                  <Button
                    variant="secondary"
                    isDisabled={busy || dirty || !saved.enabled}
                    onPress={() => {
                      void reprepare()
                    }}
                  >
                    {t('Approve execution')}
                  </Button>
                </div>
              ) : null}
            </section>
          ) : null}
          <CommunityExecutionTrial
            name={name}
            disabled={busy || dirty || !saved.enabled || (saved.preparation?.stage !== 'ready' && !saved.preparation?.usable)}
          />
        </>
      ) : null}
      {guard.dialog}
    </>
  )
}
