import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Checkbox } from '@heroui/react/checkbox'
import { Chip } from '@heroui/react/chip'
import type {
  CommunityGroupView,
  CommunitySuiteCatalogEntryView,
  CommunitySuiteCatalogView,
  CommunitySuiteInstallPreview,
  CommunitySuiteInstallView,
} from '../../src/domain/admin-contract'
import { communityGroups, communitySuiteInstallPreview, installCommunitySuite, CommunityApiRequestError } from './community-api'
import CommunityField from './CommunityField'
import CommunityDialog from './CommunityDialog'
import CommunityGrantList from './CommunityGrantList'
import { communityGroupLabel } from './community-group-label'
import { communityRequestId } from './community-request-id'
import { suiteKindLabels as kindLabels } from './community-suite-labels'
import { filledCredentials } from './community-suite-credentials'
import { Button } from '@heroui/react/button'
import { usePlatformLanguage } from './CommunityLanguage'
import { useDraftGuard } from './useDraftGuard'
import { catalogPluginDistribution, catalogServiceActions, serviceDraftKey } from './community-catalog-setup'

export default function CommunitySuiteInstallDialog({
  entry,
  titleOf,
  installation,
  children,
  onClose,
  onSubmitted,
  onAccepted,
  refreshError,
  installedDraft,
  installedBusy,
}: {
  entry: CommunitySuiteCatalogEntryView
  titleOf: (id: string) => string
  installation: CommunitySuiteInstallView | undefined
  children: (setupPending: boolean, installError: ReactNode, reload: ReactNode) => ReactNode
  onClose: () => void
  onSubmitted: () => void
  onAccepted: (view: CommunitySuiteCatalogView) => void
  refreshError: unknown
  installedDraft: boolean
  installedBusy: boolean
}) {
  const { t, locale, errorText } = usePlatformLanguage()
  const catalogIdentity = JSON.stringify([entry.id, entry.version, entry.contentHash])
  const draftIdentity = useRef(catalogIdentity)
  const [loaded, setLoaded] = useState<CommunitySuiteInstallPreview>()
  const [groups, setGroups] = useState<readonly CommunityGroupView[]>()
  const [granted, setGranted] = useState<readonly string[]>([])
  const [publish, setPublish] = useState(false)
  const [credentials, setCredentials] = useState<Readonly<Record<string, string>>>({})
  const [serviceDrafts, setServiceDrafts] = useState<Record<string, Record<string, string>>>({})
  const [setup, setSetup] = useState<Readonly<ReturnType<typeof catalogServiceActions>>>([])
  const [setupErrors, setSetupErrors] = useState<readonly { task: (typeof setup)[number]; error: unknown }[]>([])
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [setupBusy, setSetupBusy] = useState(false)
  const [previewReload, setPreviewReload] = useState(0)
  const [replace, setReplace] = useState(false)
  const [error, setError] = useState<unknown>()
  const [groupsError, setGroupsError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const requestId = useRef(communityRequestId())
  const canInstall = entry.available && (!installation || installation.status === 'failed')
  const pending = useRef(false)
  const applying = useRef(false)
  useEffect(() => {
    if (draftIdentity.current === catalogIdentity || !canInstall) return
    draftIdentity.current = catalogIdentity
    setCredentials({})
    setServiceDrafts({})
    setGranted([])
    setPublish(false)
    setReplace(false)
  }, [catalogIdentity, canInstall])
  useEffect(() => {
    if (!canInstall) return
    const controller = new AbortController()
    void communitySuiteInstallPreview(entry.id, controller.signal)
      .then(next => {
        if (!controller.signal.aborted) {
          setLoaded(next)
          setReplace(false)
        }
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    if (entry.plugin || entry.packName)
      void communityGroups(controller.signal)
        .then(next => {
          if (!controller.signal.aborted) {
            setGroups(next)
            setGroupsError(undefined)
          }
        })
        .catch(failure => {
          if (!controller.signal.aborted) setGroupsError(failure)
        })
    return () => controller.abort()
  }, [entry.id, entry.version, entry.contentHash, entry.plugin?.packageName, entry.packName, canInstall, previewReload])
  const serviceActions = catalogServiceActions(
    entry.services ?? [],
    serviceDrafts,
    locale,
    entry,
    t('Service configuration changed. Review the installed settings.'),
  )
  const runSetup = async (actions: Readonly<ReturnType<typeof catalogServiceActions>>, publishConfirmed?: true) => {
    if (applying.current) return
    applying.current = true
    setSetupBusy(true)
    setSetupErrors([])
    const remaining = setup.filter(task => !actions.includes(task))
    const failures = setupErrors.filter(({ task }) => !actions.includes(task))
    const failedOwners = new Set<string>()
    for (const action of actions) {
      if (action.owner && failedOwners.has(action.owner)) {
        remaining.push(action)
        continue
      }
      try {
        await action.run(action.kind === 'publish' ? publishConfirmed : undefined)
      } catch (failure) {
        if (action.owner) failedOwners.add(action.owner)
        remaining.push(action)
        failures.push({ task: action, error: failure })
      }
    }
    setSetup(remaining)
    setSetupErrors(failures)
    onSubmitted()
    if (!failures.length) {
      setServiceDrafts({})
      setCredentials({})
      setPublish(false)
      setGranted([])
    }
    setSetupBusy(false)
    applying.current = false
  }
  useEffect(() => {
    if (installation?.status === 'failed' && setup.length) {
      setSetup([])
      return
    }
    if (!busy && installation?.status === 'installed' && setup.length && !setupErrors.length && !setupBusy) void runSetup(setup)
  }, [busy, installation?.status, setup, setupBusy, setupErrors.length])
  const ordinaryGroups = groups?.filter(group => group.kind !== 'admin') ?? []
  const preview = loaded?.contentHash === entry.contentHash && loaded?.version === entry.version ? loaded : undefined
  const previewChanged = loaded !== undefined && preview === undefined
  const execution = entry.execution && entry.execution.variables.length ? entry.execution : undefined
  const submit = async () => {
    if (
      draftIdentity.current !== catalogIdentity ||
      pending.current ||
      !preview?.available ||
      !preview.creates.length ||
      (preview.replacements?.length && !replace)
    )
      return
    pending.current = true
    setBusy(true)
    setError(undefined)
    const filled = filledCredentials(credentials)
    try {
      const accepted = await installCommunitySuite({
        id: entry.id,
        requestId: requestId.current,
        preview: { version: preview.version, ...(preview.contentHash ? { contentHash: preview.contentHash } : {}) },
        ...(entry.packName && granted.length ? { groups: granted } : {}),
        ...(entry.packName && publish ? { publish: true } : {}),
        ...(Object.keys(filled).length ? { credentials: filled } : {}),
        ...(replace && preview?.replacements?.length ? { replace: preview.replacements } : {}),
      })
      requestId.current = communityRequestId()
      const actions = [
        ...serviceActions,
        ...(entry.plugin
          ? catalogPluginDistribution(
              { packageName: entry.plugin.packageName, integrity: entry.plugin.integrity, entryId: entry.id },
              ordinaryGroups.filter(group => granted.includes(group.id)),
              publish,
              t('Publish to the platform app center'),
            )
          : []),
      ]
      setSetup(actions)
      if (!actions.length) {
        setCredentials({})
        setGranted([])
        setPublish(false)
      }
      onAccepted(accepted)
      onSubmitted()
    } catch (failure) {
      if (failure instanceof CommunityApiRequestError && failure.code === 'suite-preview-changed') {
        setLoaded(undefined)
        setReplace(false)
        setCredentials({})
        setServiceDrafts({})
        onSubmitted()
      }
      setError(failure)
    } finally {
      setBusy(false)
      pending.current = false
    }
  }
  const manualOwners = new Set(setupErrors.flatMap(({ task }) => (task.owner && task.retryable?.() === false ? [task.owner] : [])))
  const retryTasks = setup.filter(task => !task.owner || !manualOwners.has(task.owner))
  const installing = busy || installation?.status === 'installing'
  const blocked = busy || setupBusy || installedBusy || (installation?.status === 'installing' && setup.length > 0 && !refreshError)
  const dirty =
    installedDraft ||
    (canInstall && (replace || publish || granted.length > 0 || serviceActions.length > 0 || Object.keys(filledCredentials(credentials)).length > 0)) ||
    (installation?.status !== 'failed' && setup.length > 0)
  const guard = useDraftGuard(dirty, undefined, () => {}, blocked)
  const close = () => guard.request(onClose)
  return (
    <CommunityDialog
      drawer
      drawerClassName="plugin-drawer library-form-drawer catalog-form-drawer compact-detail-drawer"
      closeLabel={t('Close catalog entry details')}
      title={entry.title[locale]}
      busy={blocked}
      onClose={close}
      footer={
        <>
          <Button variant="tertiary" isDisabled={blocked} onPress={close}>
            {t(canInstall ? 'Cancel' : 'Close')}
          </Button>
          {canInstall ? (
            <Button
              isDisabled={installing || !preview?.available || !preview.creates.length || (Boolean(preview.replacements?.length) && !replace)}
              onPress={() => {
                void submit()
              }}
            >
              {t(installation?.status === 'failed' ? 'Retry installation' : 'Install entry')}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="plugin-settings-panel catalog-install-sections">
        {entry.description[locale].trim() && entry.description[locale].trim() !== entry.title[locale].trim() ? (
          <section className="plugin-detail-section" aria-label={t('Description')}>
            <p className="catalog-entry-description">{entry.description[locale]}</p>
          </section>
        ) : null}
        {children(
          installation?.status === 'installed' && setup.length > 0 && !setupErrors.length,
          error !== undefined ? (
            <p role="alert" className="plugin-card-error">
              {errorText(error)}
            </p>
          ) : null,
          refreshError && installing ? (
            <Button variant="secondary" onPress={onSubmitted}>
              {t('Reload catalog')}
            </Button>
          ) : null,
        )}
        {setupErrors.length ? (
          <section className="plugin-detail-section">
            <CatalogWarning message={t('Installation succeeded. Some setup actions still need attention.')} />
            <ul>
              {setupErrors.map(({ task, error }, index) => (
                <li key={index}>
                  {task.label} · {errorText(error)}
                </li>
              ))}
            </ul>
            {manualOwners.size ? <p>{t('Review and enter these values in the installed service settings.')}</p> : null}
            <div className="catalog-entry-actions">
              {retryTasks.length ? (
                <Button
                  variant="secondary"
                  isDisabled={blocked || installedDraft}
                  onPress={() => {
                    if (
                      setupErrors.some(({ error }) => error instanceof CommunityApiRequestError && error.code === 'plugin-publication-credential-confirmation')
                    )
                      setConfirmPublish(true)
                    else void runSetup(retryTasks)
                  }}
                >
                  {t('Retry setup')}
                </Button>
              ) : null}
              <Button
                variant="tertiary"
                isDisabled={blocked}
                onPress={() => {
                  setSetup([])
                  setSetupErrors([])
                  setServiceDrafts({})
                }}
              >
                {t('Discard pending setup')}
              </Button>
            </div>
          </section>
        ) : null}
        {confirmPublish ? (
          <CommunityDialog
            title={t('Confirm credential sharing')}
            onClose={() => setConfirmPublish(false)}
            footer={
              <>
                <Button variant="tertiary" onPress={() => setConfirmPublish(false)}>
                  {t('Cancel')}
                </Button>
                <Button
                  onPress={() => {
                    setConfirmPublish(false)
                    void runSetup(retryTasks, true)
                  }}
                >
                  {t('Confirm')}
                </Button>
              </>
            }
          >
            <p>{t('All members can use the platform credentials through this resource.')}</p>
          </CommunityDialog>
        ) : null}
        {guard.dialog}
        {!canInstall || installing ? null : preview === undefined ? (
          <section className="plugin-detail-section">
            <h2>{t('This entry will install')}</h2>
            {error || previewChanged ? (
              <Button
                variant="secondary"
                onPress={() => {
                  setError(undefined)
                  if (previewChanged) onSubmitted()
                  setPreviewReload(value => value + 1)
                }}
              >
                {t('Reload catalog')}
              </Button>
            ) : (
              <p role="status">{t('Loading…')}</p>
            )}
          </section>
        ) : (
          <>
            <section className="plugin-detail-section">
              <h2>{t('This entry will install')}</h2>
              <ul className="grant-rows catalog-plan-rows">
                {preview.creates.map(item => {
                  const versionAt = item.kind === 'plugin' ? item.name.lastIndexOf('@') : -1
                  const name = versionAt > 0 ? item.name.slice(0, versionAt) : (item.names?.join(', ') ?? item.name)
                  const version = versionAt > 0 ? item.name.slice(versionAt + 1) : undefined
                  const meta = [item.detail, item.commands?.join(', ')].filter(Boolean).join(' · ')
                  return (
                    <li key={item.kind + ':' + item.name}>
                      <div className="grant-row-main">
                        <p className="grant-row-title catalog-plan-title">
                          <span>{t(kindLabels[item.kind])} ·</span> <strong>{name}</strong>
                          {version ? <span> · {version}</span> : null}
                        </p>
                        {meta ? <p>{meta}</p> : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
              {preview.dependencies?.length ? (
                <div className="catalog-install-dependencies">
                  <h3>{t('Shared runtime dependencies')}</h3>
                  <ul className="grant-rows">
                    {preview.dependencies.map(row => (
                      <li key={row.id}>
                        <div className="grant-row-main">
                          <strong>{titleOf(row.id)}</strong>
                          <p>
                            {row.action === 'manual'
                              ? t('Your manual dependency {name} is used; its version is not pinned', { name: row.name ?? row.id })
                              : t(row.action === 'install' ? 'Installed together with this tool' : 'Already in the library; reused without preparing again')}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preview.replacements?.length && preview.creates.length ? (
                <div className="page-stack">
                  <CatalogWarning message={t('The catalog will replace these manual entries')} />
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
              {(
                [
                  [preview.pluginConflicts, 'This plugin package belongs to another catalog entry ({names})'],
                  [preview.dependencyConflicts, 'These dependencies already provide the same commands ({names})'],
                  [preview.packConflicts, 'Rename or remove the existing manual skill packs ({names})'],
                  [preview.commandConflicts, 'Another skill already delegates these commands ({names})'],
                  [preview.conflicts, 'These skills already exist with a different origin ({names})'],
                ] as const
              ).map(([names, message]) => (names?.length ? <CatalogWarning key={message} message={t(message, { names: names.join(', ') })} /> : null))}
            </section>
            {(execution || entry.services?.length) && preview.creates.length ? (
              <section className="plugin-detail-section">
                <h2>{t('Set up service backends')}</h2>
                {entry.services?.length ? <p>{t('Service configuration is optional. You can also add it after installation.')}</p> : null}
                {execution ? (
                  <div className="page-stack">
                    <h3>{t('Team credentials (optional)')}</h3>
                    {execution.variables.map(variable => (
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
                        execution.variables.some(row => row.optional)
                          ? 'You can skip this step. Configure only the backend you use; unrelated optional settings can stay blank.'
                          : 'You can skip this step. Delegated execution stays off until every credential is saved.',
                      )}
                    </p>
                  </div>
                ) : null}
                {entry.services?.map(owner =>
                  owner.slots.map(slot => (
                    <section key={JSON.stringify([owner.kind, owner.name, slot.id])} className="catalog-service-slot" aria-label={slot.label[locale]}>
                      <h3>{slot.label[locale]}</h3>
                      {slot.backends.map(backend => {
                        const key = serviceDraftKey(owner, slot.id, backend.id)
                        return (
                          <details key={key} className="catalog-service-backend">
                            <summary>{backend.label[locale]}</summary>
                            <div className="page-stack">
                              {backend.fields.map(field => (
                                <CommunityField
                                  key={field.name}
                                  label={field.label?.[locale] ?? field.name}
                                  type={field.type === 'secret' ? 'password' : field.type}
                                  autoComplete={field.type === 'secret' ? 'new-password' : 'off'}
                                  value={serviceDrafts[key]?.[field.name] ?? ''}
                                  disabled={blocked}
                                  description={[
                                    field.label ? field.name : '',
                                    field.required
                                      ? t('Required field')
                                      : field.requiredGroup
                                        ? t('Fill one of {fields}', {
                                            fields: backend.fields
                                              .filter(other => other.requiredGroup === field.requiredGroup)
                                              .map(other => other.label?.[locale] ?? other.name)
                                              .join(' / '),
                                          })
                                        : '',
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')}
                                  onChange={value => setServiceDrafts(current => ({ ...current, [key]: { ...current[key], [field.name]: value } }))}
                                />
                              ))}
                            </div>
                          </details>
                        )
                      })}
                    </section>
                  )),
                )}
              </section>
            ) : null}
            {entry.plugin || entry.packName ? (
              <section className="plugin-detail-section">
                <h2>{t('Access and publication (optional)')}</h2>
                {groupsError ? (
                  <div className="catalog-warning-actions">
                    <CatalogWarning message={errorText(groupsError)} />
                    <Button size="sm" variant="secondary" onPress={() => setPreviewReload(value => value + 1)}>
                      {t('Reload')}
                    </Button>
                  </div>
                ) : null}
                {groups ? (
                  <CommunityGrantList
                    rows={ordinaryGroups.map(group => ({ id: group.id, name: communityGroupLabel(group, t) }))}
                    selected={granted}
                    onChange={setGranted}
                    busy={busy}
                    addLabel={t('Add groups')}
                    dialogTitle={t('Add groups')}
                    emptyLabel={t('No groups selected.')}
                    noCandidatesLabel={t('No ordinary groups available to add.')}
                  />
                ) : groupsError ? null : (
                  <p role="status">{t('Loading…')}</p>
                )}
                <Checkbox isSelected={publish} onChange={setPublish} isDisabled={busy}>
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    {t('Publish to the platform app center')}
                  </Checkbox.Content>
                </Checkbox>
                <p>{t(entry.plugin ? 'Members can manage their preinstalled copies.' : 'Both choices are optional and can be changed later.')}</p>
              </section>
            ) : null}
            <p className="catalog-install-note">{t('Preparation uses your configured download sources and verifies every download.')}</p>
          </>
        )}
      </div>
    </CommunityDialog>
  )
}

function CatalogWarning({ message }: { message: string }) {
  const { t } = usePlatformLanguage()
  return (
    <div className="catalog-warning" role="alert">
      <Chip size="sm" variant="soft" color="warning">
        {t('Warning')}
      </Chip>
      <p>{message}</p>
    </div>
  )
}
