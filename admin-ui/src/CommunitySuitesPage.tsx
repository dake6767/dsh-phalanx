import CommunitySuiteInstallDialog from './CommunitySuiteInstallDialog'
import CommunitySuiteCredentials from './CommunitySuiteCredentials'
import CommunityInstalledServiceSettings from './CommunityInstalledServiceSettings'
import CommunitySuiteDetachDialog from './CommunitySuiteDetachDialog'
import CommunitySuiteUninstallDialog from './CommunitySuiteUninstallDialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Card } from '@heroui/react/card'
import { Chip } from '@heroui/react/chip'
import CommunityIcon from './CommunityIcon'
import type { CommunitySuiteCatalogEntryView, CommunitySuiteCatalogView, CommunitySuiteInstallView } from '../../src/domain/admin-contract'
import { communitySuites } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityMessage from './CommunityMessage'
import CommunitySuiteUpdateDialog from './CommunitySuiteUpdateDialog'
import { platformError, type PlatformMessageKey } from '../../src/domain/platform-copy'

import { suiteKindLabels as kindLabels } from './community-suite-labels'
/** Stable catalog rejection reasons map to localized explanations; anything else is shown as the diagnostic. */
const rejectionMessages: Readonly<Record<string, PlatformMessageKey>> = {
  'invalid-document': 'The catalog is not a valid signed document.',
  'unsupported-format': 'The catalog uses a format this platform version does not read.',
  'unknown-key': 'The catalog was signed with a key this platform does not trust.',
  'invalid-signature': 'The catalog signature is invalid.',
}
const entryError = (entry: CommunitySuiteCatalogEntryView): PlatformMessageKey | undefined => {
  if (entry.unavailableReason === 'needs-platform-upgrade' || entry.unavailableReason === 'unknown-adapter') return 'Needs a newer platform version'
  if (entry.unavailableReason === 'content-tampered') return 'The catalog content for this version changed after it was installed.'
  if (entry.unavailableReason === 'content-hash-mismatch') return 'The catalog entry content does not match its declared hash.'
  if (entry.unavailableReason === 'dependency-missing') return 'A shared dependency is missing from the catalog.'
  if (entry.unavailableReason === 'invalid-entry') return 'The catalog entry failed the platform download checks.'
  if (entry.unavailableReason === 'invalid-adapter-params') return 'The catalog entry has invalid adapter parameters.'
  return entry.available ? undefined : 'Unavailable on this architecture'
}

export default function CommunitySuitesPage({ category = 'suite', onLibraryChanged }: { category?: 'suite' | 'plugin'; onLibraryChanged?: () => void }) {
  const { t, locale, errorText } = usePlatformLanguage()
  const [view, setView] = useState<CommunitySuiteCatalogView>()
  const [uninstalling, setUninstalling] = useState<CommunitySuiteCatalogEntryView>()
  const [updating, setUpdating] = useState<CommunitySuiteCatalogEntryView>()
  const [selectedEntry, setDetails] = useState<CommunitySuiteCatalogEntryView>()
  const [detaching, setDetaching] = useState<{ id: string; entry: CommunitySuiteInstallView['entries'][number] }>()
  const [drafts, setDrafts] = useState<Record<string, { dirty: boolean; busy: boolean }>>({})
  const reportDraft = useCallback((key: string, dirty: boolean, busy: boolean) => {
    setDrafts(current => {
      if (!dirty && !busy && !Object.hasOwn(current, key)) return current
      const next = { ...current }
      if (dirty || busy) next[key] = { dirty, busy }
      else delete next[key]
      return next
    })
  }, [])
  const [error, setError] = useState<unknown>()
  const [revision, setRevision] = useState(0)
  const lastInstalls = useRef<string | undefined>(undefined)
  const refresh = () => setRevision(value => value + 1)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const next = await communitySuites(controller.signal)
        if (controller.signal.aborted) return
        const settled = JSON.stringify(next.installations.filter(row => row.status === 'installed').map(row => [row.id, row.version, row.entries]))
        if (lastInstalls.current !== undefined && lastInstalls.current !== settled) onLibraryChanged?.()
        lastInstalls.current = settled
        setView(next)
        setError(undefined)
        if (next.installations.some(row => row.status === 'installing' || row.status === 'uninstalling' || row.status === 'updating'))
          timer = setTimeout(() => {
            void load()
          }, 1000)
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure)
      }
    }
    void load()
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [revision, onLibraryChanged])
  const entries = view?.entries ?? []
  const visible = entries.filter(entry => entry.category === category)
  const details = entries.find(entry => entry.id === selectedEntry?.id) ?? selectedEntry
  const installationOf = (entry: CommunitySuiteCatalogEntryView): CommunitySuiteInstallView | undefined => view?.installations.find(row => row.id === entry.id)
  const selectedInstallation = details ? installationOf(details) : undefined
  const installedBusy = Object.values(drafts).some(draft => draft.busy)
  const installedDraft = Object.values(drafts).some(draft => draft.dirty)
  const statusOf = (entry: CommunitySuiteCatalogEntryView): { label: string; tone: 'success' | 'warning' | 'danger' | 'default'; busy: boolean } => {
    const installation = installationOf(entry)
    if (!installation) return { label: t('Not installed'), tone: 'default', busy: false }
    if (installation.status === 'installed' && entry.updateAvailable) return { label: t('Update available'), tone: 'success', busy: false }
    if (installation.status === 'installed') return { label: t('Installed'), tone: 'success', busy: false }
    if (installation.status === 'failed') return { label: t('Installation failed. You can retry.'), tone: 'danger', busy: false }
    return {
      label: t(installation.status === 'installing' ? 'Installing' : installation.status === 'updating' ? 'Updating' : 'Uninstalling'),
      tone: 'warning',
      busy: true,
    }
  }
  const selectedStatus = details ? statusOf(details) : undefined
  const titleOf = (id: string): string => entries.find(row => row.id === id)?.title[locale] ?? id
  // Installation records stay usable when the catalog is unreachable or a whole document was rejected.
  const catalogIds = new Set(entries.map(entry => entry.id))
  const outsideCatalog = (view?.installations ?? []).filter(row => !catalogIds.has(row.id) && (row.category ?? 'suite') === category)
  const outsideEntry = (row: CommunitySuiteInstallView): CommunitySuiteCatalogEntryView => ({
    id: row.id,
    category,
    title: { en: row.id, 'zh-CN': row.id },
    description: { en: '', 'zh-CN': '' },
    source: { en: '', 'zh-CN': '' },
    version: row.version,
    commands: [],
    available: false,
  })
  // A catalog dependency that suites satisfy with a same-command manual dependency instead of its own copy.
  const manualOf = (entry: CommunitySuiteCatalogEntryView): string | undefined =>
    view?.installations.flatMap(row => row.manualDependencies ?? []).find(row => row.id === entry.id)?.name
  const referenceText = (reference: { kind: string; name: string }) =>
    reference.kind === 'suite'
      ? `${t('Catalog entry')} · ${titleOf(reference.name)}`
      : `${Object.hasOwn(kindLabels, reference.kind) ? t(kindLabels[reference.kind as keyof typeof kindLabels]) : reference.kind} · ${reference.name}`
  return (
    <div className="community-page">
      {error !== undefined ? (
        <>
          <CommunityMessage role="alert" status="danger" title={errorText(error)} />
          <Button variant="secondary" onPress={refresh}>
            {t('Reload catalog')}
          </Button>
        </>
      ) : null}
      {view?.source.status === 'unreachable' ? (
        <CommunityMessage role="alert" status="warning" title={t('The catalog service is unreachable')}>
          <p>{view.source.address}</p>
          <p>{view.source.reason ?? ''}</p>
          <p>{t('Installed tools and runtime dependencies keep working, and entries outside the catalog can still be uninstalled.')}</p>
          <Button variant="secondary" size="sm" onPress={refresh}>
            {t('Reload catalog')}
          </Button>
        </CommunityMessage>
      ) : null}
      {view?.source.status === 'rejected' ? (
        <CommunityMessage role="alert" status="danger" title={t('The catalog was rejected')}>
          <p>{view.source.address}</p>
          <p>
            {view.source.reason && Object.hasOwn(rejectionMessages, view.source.reason)
              ? t(rejectionMessages[view.source.reason]!)
              : (view.source.reason ?? '')}
          </p>
        </CommunityMessage>
      ) : null}
      <section className="panel plugin-library-panel" aria-label={t(category === 'plugin' ? 'Plugin catalog' : 'Skill catalog')}>
        <div className="panel-top panel-filter-header">
          <div>
            <div className="panel-title-row">
              <h2>{t(category === 'plugin' ? 'Plugin catalog' : 'Skill catalog')}</h2>
              <span className="panel-item-count">{t('{count} entries', { count: view ? visible.length : '—' })}</span>
            </div>
            <p>{t('Review what each entry installs before you install it.')}</p>
          </div>
        </div>
        {view === undefined ? (
          <p className="table-empty" role="status">
            {t('Loading…')}
          </p>
        ) : visible.length === 0 ? (
          <Card className="plugin-library-empty" variant="transparent">
            <Card.Header>
              <Card.Title>{t('The catalog is empty.')}</Card.Title>
              <Card.Description>{t('The catalog returned no entries for this platform.')}</Card.Description>
            </Card.Header>
          </Card>
        ) : (
          <div className="plugin-card-grid library-compact-grid">
            {visible.map(entry => {
              const installation = installationOf(entry),
                status = statusOf(entry)
              return (
                <Card key={entry.id} className="plugin-library-card catalog-entry-card">
                  <Card.Header>
                    <div className="library-card-heading">
                      <Card.Title>{entry.title[locale]}</Card.Title>
                      <CommunityIcon name="chevron" size={14} />
                    </div>
                    <p className="plugin-summary-meta">
                      {entry.source[locale]} · v{entry.version}
                      {entry.plugin
                        ? ` · ${entry.plugin.packageName}`
                        : entry.skills?.length
                          ? ` · ${t('{count} skills', { count: entry.skills.length })}`
                          : ''}
                    </p>
                    <Card.Description>{entry.description[locale]}</Card.Description>
                  </Card.Header>
                  {entryError(entry) ? <p className="plugin-card-error">{t(entryError(entry)!)}</p> : null}
                  {entry.unavailableDetail ? <p className="plugin-card-error">{entry.unavailableDetail}</p> : null}
                  {manualOf(entry) !== undefined && installation === undefined ? (
                    <p className="plugin-summary-meta">{t('Your manual dependency {name} is used; its version is not pinned', { name: manualOf(entry)! })}</p>
                  ) : null}
                  {installation?.failureCode === 'skill-catalog-limit-exceeded' ? (
                    <p className="plugin-card-error" role="alert">
                      {platformError(locale, { code: 'skill-catalog-limit-exceeded', error: '' })}
                    </p>
                  ) : null}
                  <Card.Footer className="plugin-card-status">
                    <Chip size="sm" variant="soft" color={status.tone}>
                      <span role="status">{status.label}</span>
                    </Chip>
                    <div className="catalog-entry-actions">
                      {installation?.status === 'installed' ? (
                        <>
                          {entry.updateAvailable ? (
                            <Button className="relative z-10" size="sm" variant="primary" onPress={() => setUpdating(entry)}>
                              {t('Update')}
                            </Button>
                          ) : null}
                          <Button className="relative z-10" size="sm" variant="tertiary" isDisabled={status.busy} onPress={() => setUninstalling(entry)}>
                            {t('Uninstall')}
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </Card.Footer>
                  <Button
                    variant="tertiary"
                    size="sm"
                    aria-label={t('View catalog entry {name}', { name: entry.title[locale] })}
                    className="plugin-details-action"
                    onPress={() => setDetails(entry)}
                  />
                </Card>
              )
            })}
          </div>
        )}
        <div className="panel-footer plugin-library-note">
          <CommunityIcon name="shield" size={16} />
          <span>{t('Installing an entry does not grant it to groups or publish it.')}</span>
        </div>
      </section>
      {outsideCatalog.length ? (
        <section className="panel plugin-library-panel" aria-label={t('Installed entries outside the catalog')}>
          <div className="panel-top">
            <div>
              <h2>{t('Installed entries outside the catalog')}</h2>
              <p>{t('These entries are installed from local records. They can still be used and uninstalled while the catalog is unavailable.')}</p>
            </div>
          </div>
          <ul className="plugin-card-grid">
            {outsideCatalog.map(row => (
              <li key={row.id} className="plugin-library-card">
                <div>
                  <strong>{row.id}</strong> · {row.version} ·{' '}
                  <span role="status">
                    {t(row.status === 'failed' ? 'Installation failed. You can retry.' : row.status === 'installed' ? 'Installed' : 'Installing')}
                  </span>
                </div>
                <ul>
                  {row.entries.map(entry => (
                    <li key={entry.kind + ':' + entry.name}>
                      {t(kindLabels[entry.kind])} · {entry.name}
                      {row.status === 'installed' ? (
                        <>
                          {' '}
                          <Button
                            size="sm"
                            variant="tertiary"
                            aria-label={t('Detach {name} from {tool}', { name: entry.name, tool: row.id })}
                            onPress={() => setDetaching({ id: row.id, entry })}
                          >
                            {t('Detach from {tool}', { tool: row.id })}
                          </Button>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <div className="catalog-entry-actions">
                  <Button size="sm" variant="secondary" onPress={() => setDetails(outsideEntry(row))}>
                    {t('Catalog entry details')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={row.status !== 'installed' && row.status !== 'failed'}
                    onPress={() => setUninstalling(outsideEntry(row))}
                  >
                    {t('Uninstall')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {detaching ? (
        <CommunitySuiteDetachDialog
          tool={titleOf(detaching.id)}
          suite={detaching.id}
          entry={detaching.entry}
          onClose={() => setDetaching(undefined)}
          onSubmitted={() => {
            setDetaching(undefined)
            refresh()
          }}
        />
      ) : null}
      {updating ? (
        <CommunitySuiteUpdateDialog
          entry={updating}
          titleOf={titleOf}
          onClose={() => setUpdating(undefined)}
          onSubmitted={() => {
            setUpdating(undefined)
            refresh()
          }}
        />
      ) : null}
      {uninstalling ? (
        <CommunitySuiteUninstallDialog
          referenceText={referenceText}
          entry={uninstalling}
          titleOf={titleOf}
          onClose={() => setUninstalling(undefined)}
          onSubmitted={() => {
            setUninstalling(undefined)
            refresh()
          }}
        />
      ) : null}
      {details ? (
        <CommunitySuiteInstallDialog
          key={details.id}
          entry={details}
          installation={selectedInstallation}
          installedDraft={installedDraft}
          installedBusy={installedBusy}
          onAccepted={setView}
          refreshError={error}
          titleOf={titleOf}
          onClose={() => setDetails(undefined)}
          onSubmitted={refresh}
        >
          {setupPending => (
            <div className="plugin-settings-panel">
              <section className="plugin-detail-section">
                <div className="plugin-section-heading">
                  <h2>{t('Installation record')}</h2>
                  <Chip size="sm" variant="soft" color={selectedStatus?.tone}>
                    <span role="status">{selectedStatus?.label}</span>
                  </Chip>
                </div>
                {installationOf(details)?.failureCode === 'skill-catalog-limit-exceeded' ? (
                  <CommunityMessage role="alert" status="danger" title={platformError(locale, { code: 'skill-catalog-limit-exceeded', error: '' })} />
                ) : null}
                {entryError(details) && !selectedInstallation ? <p className="plugin-card-error">{t(entryError(details)!)}</p> : null}
                {details.unavailableDetail ? <p className="plugin-card-error">{details.unavailableDetail}</p> : null}
                <details className="mcp-preparation-log">
                  <summary>{t('Technical details')}</summary>
                  <dl className="catalog-entry-facts">
                    <div>
                      <dt>{t('Source')}</dt>
                      <dd>{details.source[locale]}</dd>
                    </div>
                    <div>
                      <dt>{t('Catalog version')}</dt>
                      <dd>
                        {selectedInstallation?.version ?? details.version}
                        {details.updateAvailable ? ` → ${details.version}` : ''}
                      </dd>
                    </div>
                    {details.plugin ? (
                      <div>
                        <dt>{t('Package')}</dt>
                        <dd>
                          {details.plugin.packageName}@{details.plugin.version}
                        </dd>
                      </div>
                    ) : null}
                    {details.packName ? (
                      <div>
                        <dt>{t('Skill pack')}</dt>
                        <dd>{details.packName}</dd>
                      </div>
                    ) : null}
                    {details.serviceAddresses?.length ? (
                      <div>
                        <dt>{t('Service addresses')}</dt>
                        <dd>{details.serviceAddresses.join(', ')}</dd>
                      </div>
                    ) : null}
                    {details.execution ? (
                      <div>
                        <dt>{t('Delegated execution')}</dt>
                        <dd>
                          {details.execution.commands
                            .map(
                              row => row.command + (row.blocked.length ? ` (${t('Blocked first arguments: {names}', { names: row.blocked.join(' ') })})` : ''),
                            )
                            .join(', ')}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                </details>
                {selectedInstallation?.dependencies?.length ? (
                  <ul className="grant-rows">
                    {selectedInstallation.dependencies
                      .filter(id => !selectedInstallation.manualDependencies?.some(row => row.id === id))
                      .map(id => (
                        <li key={id}>{titleOf(id)}</li>
                      ))}
                  </ul>
                ) : null}
                {installationOf(details)?.manualDependencies?.length ? (
                  <ul className="grant-rows">
                    {installationOf(details)!.manualDependencies!.map(row => (
                      <li key={row.id}>
                        <div className="grant-row-main">
                          <strong>{titleOf(row.id)}</strong>
                          <p>{t('Your manual dependency {name} is used; its version is not pinned', { name: row.name })}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
              {selectedInstallation?.status === 'installed' && selectedInstallation.execution?.variables?.length ? (
                <section className="plugin-detail-section">
                  <CommunitySuiteCredentials
                    key={JSON.stringify([selectedInstallation.version, selectedInstallation.contentHash])}
                    entry={details}
                    installation={selectedInstallation}
                    onSaved={refresh}
                    onDraft={reportDraft}
                  />
                </section>
              ) : null}
              {!setupPending && selectedInstallation?.status === 'installed'
                ? selectedInstallation.entries.map(({ kind, name }) =>
                    kind === 'execution' || kind === 'plugin' ? (
                      <CommunityInstalledServiceSettings key={kind + ':' + name} kind={kind} name={name} onDraft={reportDraft} />
                    ) : null,
                  )
                : null}
              {installationOf(details)?.entries.length ? (
                <section className="plugin-detail-section">
                  <h2>{t('Installed entries')}</h2>
                  <p className="section-note">{t('Catalog entries are managed together and remain read-only until detached.')}</p>
                  <ul className="grant-rows">
                    {installationOf(details)!.entries.map(entry => (
                      <li key={entry.kind + ':' + entry.name}>
                        <div className="grant-row-main">
                          <strong>{entry.name}</strong>
                          <p>{t(kindLabels[entry.kind])}</p>
                        </div>
                        {installationOf(details)!.status === 'installed' ? (
                          <Button
                            size="sm"
                            variant="tertiary"
                            aria-label={t('Detach {name} from {tool}', { name: entry.name, tool: details.title[locale] })}
                            isDisabled={installedDraft || installedBusy}
                            onPress={() => setDetaching({ id: details.id, entry })}
                          >
                            {t('Detach')}
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {installationOf(details)?.replaced?.length ? (
                <section className="plugin-detail-section">
                  <h2>{t('Replaced manual entries')}</h2>
                  <ul className="grant-rows">
                    {installationOf(details)!.replaced!.map(row => (
                      <li key={row.kind + ':' + row.name}>
                        <div className="grant-row-main">
                          <strong>{row.name}</strong>
                          <p>{t(kindLabels[row.kind])}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {installationOf(details)?.log ? (
                <section className="plugin-detail-section">
                  <details className="mcp-preparation-log">
                    <summary>{t('Task log')}</summary>
                    <pre className="plugin-preparation-log">{installationOf(details)!.log}</pre>
                  </details>
                </section>
              ) : null}
            </div>
          )}
        </CommunitySuiteInstallDialog>
      ) : null}
    </div>
  )
}
