import CommunitySuiteInstallDialog from './CommunitySuiteInstallDialog'
import CommunitySuiteCredentials from './CommunitySuiteCredentials'
import CommunitySuiteDetachDialog from './CommunitySuiteDetachDialog'
import CommunitySuiteUninstallDialog from './CommunitySuiteUninstallDialog'
import { useEffect, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Card } from '@heroui/react/card'
import { Chip } from '@heroui/react/chip'
import CommunityIcon from './CommunityIcon'
import type { CommunitySuiteCatalogEntryView, CommunitySuiteCatalogView, CommunitySuiteInstallView } from '../../src/domain/admin-contract'
import { communitySuites } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityDialog from './CommunityDialog'
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

export default function CommunitySuitesPage({ category = 'suite' }: { category?: 'suite' | 'plugin' }) {
  const { t, locale, errorText } = usePlatformLanguage()
  const [view, setView] = useState<CommunitySuiteCatalogView>()
  const [installing, setInstalling] = useState<CommunitySuiteCatalogEntryView>()
  const [uninstalling, setUninstalling] = useState<CommunitySuiteCatalogEntryView>()
  const [updating, setUpdating] = useState<CommunitySuiteCatalogEntryView>()
  const [details, setDetails] = useState<CommunitySuiteCatalogEntryView>()
  const [detaching, setDetaching] = useState<{ id: string; entry: CommunitySuiteInstallView['entries'][number] }>()
  const [error, setError] = useState<unknown>()
  const [revision, setRevision] = useState(0)
  const refresh = () => setRevision(value => value + 1)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const next = await communitySuites(controller.signal)
        if (controller.signal.aborted) return
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
  }, [revision])
  const entries = view?.entries ?? []
  const visible = entries.filter(entry => entry.category === category)
  const installationOf = (entry: CommunitySuiteCatalogEntryView): CommunitySuiteInstallView | undefined => view?.installations.find(row => row.id === entry.id)
  const statusOf = (entry: CommunitySuiteCatalogEntryView): { label: string; tone: 'success' | 'warning' | 'danger' | 'default'; busy: boolean } => {
    const installation = installationOf(entry)
    if (!installation) return { label: t('Not installed'), tone: 'default', busy: false }
    if (installation.status === 'installed' && entry.updateAvailable) return { label: t('Update available'), tone: 'success', busy: false }
    if (installation.status === 'installed' && installation.missingCredentials?.length) return { label: t('Missing credentials'), tone: 'warning', busy: false }
    if (installation.status === 'installed') return { label: t('Installed'), tone: 'success', busy: false }
    if (installation.status === 'failed') return { label: t('Installation failed. You can retry.'), tone: 'danger', busy: false }
    return {
      label: t(installation.status === 'installing' ? 'Installing' : installation.status === 'updating' ? 'Updating' : 'Uninstalling'),
      tone: 'warning',
      busy: true,
    }
  }
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
  const stageClass = (tone: 'success' | 'warning' | 'danger' | 'default'): string =>
    tone === 'danger' ? 'plugin-stage is-failed' : tone === 'success' ? 'plugin-stage is-available' : 'plugin-stage is-preparing'
  return (
    <div className="community-page">
      <section className="panel-top">
        <div>
          <h2>{t(category === 'plugin' ? 'Plugin catalog' : 'Skill catalog')}</h2>
          <p>{t('Browse tools and review the skills and dependencies they provide.')}</p>
        </div>
      </section>
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
      <section className="panel plugin-library-panel" aria-label={t('All catalog entries')}>
        <div className="panel-top panel-filter-header">
          <div>
            <div className="panel-title-row">
              <h2>{t('All catalog entries')}</h2>
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
          <div className="plugin-card-grid">
            {visible.map(entry => (
              <Card key={entry.id} className="plugin-library-card">
                <Card.Header>
                  <div className="plugin-card-top">
                    <span className="plugin-card-icon" aria-hidden="true">
                      <CommunityIcon name="suites" size={20} />
                    </span>
                    <Chip size="sm" variant="soft">
                      {t('Skills')}
                    </Chip>
                  </div>
                  <Card.Title>{entry.title[locale]}</Card.Title>
                  <Card.Description>{entry.description[locale]}</Card.Description>
                </Card.Header>
                <Card.Content>
                  <dl className="plugin-card-metadata">
                    <div>
                      <dt>{t('Source')}</dt>
                      <dd>{entry.source[locale]}</dd>
                    </div>
                    <div>
                      <dt>{t('Version')}</dt>
                      <dd>{entry.version}</dd>
                    </div>
                    {entry.commands.length ? (
                      <div>
                        <dt>{t('Commands')}</dt>
                        <dd>{entry.commands.join(', ')}</dd>
                      </div>
                    ) : null}
                    {entry.skills?.length ? (
                      <div>
                        <dt>{t('Skills')}</dt>
                        <dd>{t('{count} skills', { count: entry.skills.length })}</dd>
                      </div>
                    ) : null}
                    {entry.dependencies?.length ? (
                      <div>
                        <dt>{t('Shared dependencies')}</dt>
                        <dd>{entry.dependencies.map(id => titleOf(id)).join(', ')}</dd>
                      </div>
                    ) : null}
                    {entry.serviceAddresses?.length ? (
                      <div>
                        <dt>{t('Service addresses')}</dt>
                        <dd>{entry.serviceAddresses.join(', ')}</dd>
                      </div>
                    ) : null}
                  </dl>
                  {entryError(entry) ? <p className="plugin-card-error">{t(entryError(entry)!)}</p> : null}
                  {entry.unavailableDetail ? <p className="plugin-card-error">{entry.unavailableDetail}</p> : null}
                  {manualOf(entry) !== undefined && installationOf(entry) === undefined ? (
                    <p>{t('Your manual dependency {name} is used; its version is not pinned', { name: manualOf(entry)! })}</p>
                  ) : null}
                  {installationOf(entry)?.failureCode === 'skill-catalog-limit-exceeded' ? (
                    <p className="plugin-card-error" role="alert">
                      {platformError(locale, { code: 'skill-catalog-limit-exceeded', error: '' })}
                    </p>
                  ) : null}
                  <div className="plugin-card-status" role="status">
                    <span className={stageClass(statusOf(entry).tone)}>
                      <span aria-hidden="true" />
                      {statusOf(entry).label}
                    </span>
                  </div>
                </Card.Content>
                <Card.Footer>
                  <span className="plugin-details-label" aria-hidden="true">
                    {t('Catalog entry details')}
                    <CommunityIcon name="chevron" size={14} />
                  </span>
                  <Button
                    variant="tertiary"
                    size="sm"
                    aria-label={t('View catalog entry {name}', { name: entry.title[locale] })}
                    className="plugin-details-action"
                    onPress={() => setDetails(entry)}
                  />
                  {installationOf(entry) === undefined ? (
                    <Button className="relative z-10" size="sm" variant="secondary" isDisabled={!entry.available} onPress={() => setInstalling(entry)}>
                      {t(manualOf(entry) !== undefined ? 'Switch to the catalog version' : 'Install')}
                    </Button>
                  ) : installationOf(entry)?.status === 'failed' ? (
                    <Button className="relative z-10" size="sm" variant="secondary" onPress={() => setInstalling(entry)}>
                      {t('Retry install')}
                    </Button>
                  ) : installationOf(entry)?.status === 'installed' ? (
                    <>
                      {entry.updateAvailable ? (
                        <Button className="relative z-10" size="sm" variant="primary" onPress={() => setUpdating(entry)}>
                          {t('Update')}
                        </Button>
                      ) : null}
                      <Button className="relative z-10" size="sm" variant="secondary" isDisabled={statusOf(entry).busy} onPress={() => setUninstalling(entry)}>
                        {t('Uninstall')}
                      </Button>
                    </>
                  ) : null}
                </Card.Footer>
              </Card>
            ))}
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
                <div>
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
      {installing ? (
        <CommunitySuiteInstallDialog
          entry={installing}
          titleOf={titleOf}
          onClose={() => setInstalling(undefined)}
          onSubmitted={() => {
            setInstalling(undefined)
            refresh()
          }}
        />
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
        <CommunityDialog
          drawer
          drawerClassName="plugin-drawer"
          eyebrow={t('Installation record')}
          title={details.title[locale]}
          closeLabel={t('Close catalog entry details')}
          onClose={() => setDetails(undefined)}
        >
          <div className="drawer-identity plugin-identity">
            <span className="plugin-card-icon" aria-hidden="true">
              <CommunityIcon name="suites" size={22} />
            </span>
            <div>
              <strong>{details.title[locale]}</strong>
              <span>
                {details.source[locale]} · {t('Catalog version {version}', { version: details.version })}
              </span>
            </div>
            <Chip size="sm" variant="soft" color={statusOf(details).tone}>
              <span role="status">{statusOf(details).label}</span>
            </Chip>
          </div>
          <div className="plugin-detail-sections">
            <section className="plugin-detail-section">
              <h2>{t('Installation record')}</h2>
              {installationOf(details)?.failureCode === 'skill-catalog-limit-exceeded' ? (
                <CommunityMessage role="alert" status="danger" title={platformError(locale, { code: 'skill-catalog-limit-exceeded', error: '' })} />
              ) : null}
              <dl className="plugin-card-metadata">
                <div>
                  <dt>{t('Version')}</dt>
                  <dd>{installationOf(details)?.version ?? details.version}</dd>
                </div>
                {details.identity ? (
                  <div>
                    <dt>{t('Identity')}</dt>
                    <dd>{details.identity[locale]}</dd>
                  </div>
                ) : null}
                {details.dependencies?.length ? (
                  <div>
                    <dt>{t('Shared dependencies')}</dt>
                    <dd>{details.dependencies.map(titleOf).join(', ')}</dd>
                  </div>
                ) : null}
                {details.packName ? (
                  <div>
                    <dt>{t('Skill pack')}</dt>
                    <dd>{details.packName}</dd>
                  </div>
                ) : null}
                {details.execution ? (
                  <div>
                    <dt>{t('Delegated execution')}</dt>
                    <dd>
                      {details.execution.commands
                        .map(row => row.command + (row.blocked.length ? ` (${t('Blocked first arguments: {names}', { names: row.blocked.join(' ') })})` : ''))
                        .join(', ')}
                    </dd>
                  </div>
                ) : null}
              </dl>
              {installationOf(details)?.manualDependencies?.length ? (
                <>
                  <h2>{t('Shared dependencies')}</h2>
                  <ul>
                    {installationOf(details)!.manualDependencies!.map(row => (
                      <li key={row.id}>
                        {titleOf(row.id)} · {t('Your manual dependency {name} is used; its version is not pinned', { name: row.name })}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {installationOf(details)?.replaced?.length ? (
                <>
                  <h2>{t('Replaced manual entries')}</h2>
                  <ul>
                    {installationOf(details)!.replaced!.map(row => (
                      <li key={row.kind + ':' + row.name}>
                        {t(kindLabels[row.kind])} · {row.name}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {details.execution && installationOf(details)?.status === 'installed' ? (
                <CommunitySuiteCredentials entry={details} installation={installationOf(details)!} onSaved={refresh} />
              ) : null}
              <p>{t('Catalog entries are managed together and remain read-only until detached.')}</p>
              {installationOf(details)?.entries.length ? (
                <>
                  <h2>{t('Installed entries')}</h2>
                  <ul>
                    {installationOf(details)!.entries.map(entry => (
                      <li key={entry.kind + ':' + entry.name}>
                        {t(kindLabels[entry.kind])} · {entry.name}
                        {installationOf(details)!.status === 'installed' ? (
                          <>
                            {' '}
                            <Button
                              size="sm"
                              variant="tertiary"
                              aria-label={t('Detach {name} from {tool}', { name: entry.name, tool: details.title[locale] })}
                              onPress={() => setDetaching({ id: details.id, entry })}
                            >
                              {t('Detach from {tool}', { tool: details.title[locale] })}
                            </Button>
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {installationOf(details) ? (
                <>
                  <h2>{t('Task log')}</h2>
                  <pre className="plugin-preparation-log">{installationOf(details)!.log}</pre>
                </>
              ) : null}
            </section>
          </div>
        </CommunityDialog>
      ) : null}
    </div>
  )
}
