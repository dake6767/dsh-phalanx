import { McpDisplayFields } from './CommunityMcpFields'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Card } from '@heroui/react/card'
import { Chip } from '@heroui/react/chip'
import type { CommunityMcpCatalogEntry, CommunityMcpSettings, CommunityMcpCatalogInput } from '../../src/domain/admin-contract'
import { communityMcpCatalog, importCommunityMcp } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityDialog from './CommunityDialog'
import CommunityField from './CommunityField'
import CommunityIcon from './CommunityIcon'
import CommunityMessage from './CommunityMessage'
import { communityRequestId } from './community-request-id'

const locationKey = (location: CommunityMcpCatalogEntry['location']) =>
  location === 'remote' ? 'Remote service' : location === 'shared' ? 'Shared run' : 'Member container run'

export default function CommunityMcpCatalog({
  rows,
  onImported,
}: {
  rows?: readonly CommunityMcpSettings[]
  onImported: (rows: readonly CommunityMcpSettings[]) => void
}) {
  const { t, locale, errorText } = usePlatformLanguage()
  const [entries, setEntries] = useState<readonly CommunityMcpCatalogEntry[]>(),
    [error, setError] = useState<unknown>(),
    [selected, setSelected] = useState<CommunityMcpCatalogEntry>()
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void communityMcpCatalog(controller.signal)
      .then(setEntries)
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    return () => controller.abort()
  }, [revision])
  return (
    <section className="panel plugin-library-panel" aria-label={t('MCP catalog')}>
      <div className="panel-top panel-filter-header">
        <div>
          <div className="panel-title-row">
            <h2>{t('MCP catalog')}</h2>
            <span className="panel-item-count">{entries?.length ?? '—'}</span>
          </div>
          <p>{t('Platform-maintained MCP services. Enter the required inputs to prepare and test a service.')}</p>
        </div>
      </div>
      {error ? (
        <>
          <CommunityMessage role="alert" status="danger" title={errorText(error)} />
          <Button
            variant="secondary"
            onPress={() => {
              setError(undefined)
              setRevision(value => value + 1)
            }}
          >
            {t('Reload MCP services')}
          </Button>
        </>
      ) : null}
      {!entries ? (
        <p role="status" className="table-empty">
          {t('Loading…')}
        </p>
      ) : (
        <div className="plugin-card-grid library-compact-grid">
          {entries.map(entry => {
            const count = rows?.filter(row => row.catalog?.id === entry.id).length ?? entry.imported
            return (
              <Card key={entry.id} className="plugin-library-card mcp-catalog-card">
                <Card.Header>
                  <div className="library-card-heading">
                    <Card.Title>{entry.title[locale]}</Card.Title>
                    <CommunityIcon name="chevron" size={14} />
                  </div>
                  <p className="plugin-summary-meta catalog-card-meta" title={`${t('Platform catalog')} · v${entry.version}`}>
                    {t('Platform catalog')} · v{entry.version}
                  </p>
                  {entry.description[locale].trim() !== entry.title[locale].trim() ? <Card.Description>{entry.description[locale]}</Card.Description> : null}
                </Card.Header>
                <Card.Footer className="plugin-card-status">
                  <span className="mcp-catalog-credential">{entry.credentialLabel?.[locale] ?? t('No credential required')}</span>
                  {count ? (
                    <Chip size="sm" variant="soft" color="success">
                      {t('{count} imported services', { count })}
                    </Chip>
                  ) : null}
                </Card.Footer>
                <Button
                  className="plugin-details-action"
                  variant="tertiary"
                  size="sm"
                  aria-label={t('View MCP service {name}', { name: entry.title[locale] })}
                  onPress={() => setSelected(entry)}
                />
              </Card>
            )
          })}
        </div>
      )}
      <div className="panel-footer plugin-library-note">
        <CommunityIcon name="shield" size={16} />
        <span>{t('Adding a service does not grant access or publish it.')}</span>
      </div>
      {selected ? (
        <CatalogImport
          entry={selected}
          imports={rows?.flatMap(row => (row.catalog?.id === selected.id ? [row.catalog.status] : []))}
          onClose={() => setSelected(undefined)}
          onImported={next => {
            onImported(next)
            setSelected(undefined)
          }}
        />
      ) : null}
    </section>
  )
}
function CatalogImport({
  entry,
  imports,
  onClose,
  onImported,
}: {
  entry: CommunityMcpCatalogEntry
  imports: readonly NonNullable<CommunityMcpSettings['catalog']>['status'][] | undefined
  onClose: () => void
  onImported: (rows: readonly CommunityMcpSettings[]) => void
}) {
  const { t, locale, errorText } = usePlatformLanguage(),
    id = useId()
  const [name, setName] = useState(`p-${entry.id}`),
    [credential, setCredential] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>()
  const [display, setDisplay] = useState<CommunityMcpCatalogInput['display']>()
  const [requestId] = useState(communityRequestId),
    pending = useRef(false)
  const ready = imports?.filter(status => status === 'ready').length ?? 0
  const activity = imports?.includes('preparing') ? 'Preparing dependencies…' : imports?.includes('testing') ? 'Testing imported service…' : undefined
  const failed = imports?.includes('failed')
  const installationStatus = activity
    ? ({ color: 'warning', label: t(activity) } as const)
    : failed
      ? ({ color: 'danger', label: t('Import failed') } as const)
      : ready
        ? ({ color: 'success', label: t('{count} imported services', { count: ready }) } as const)
        : ({
            color: 'default',
            label: imports === undefined && entry.imported ? t('{count} imported services', { count: entry.imported }) : t('Not installed'),
          } as const)
  const submit = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      const rows = await importCommunityMcp({ name, credential, presetId: entry.id, requestId, ...(display ? { display } : {}) })
      setCredential('')
      onImported(rows)
    } catch (failure) {
      setError(failure)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <CommunityDialog
      drawer
      drawerClassName="plugin-drawer library-form-drawer mcp-service-drawer compact-detail-drawer"
      title={entry.title[locale]}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="tertiary" isDisabled={busy} onPress={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" form={id} isDisabled={busy || Boolean(entry.credentialLabel && !credential.trim())}>
            {t('Import MCP service')}
          </Button>
        </>
      }
    >
      <form
        id={id}
        className="plugin-settings-panel catalog-install-sections mcp-catalog-import"
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        {entry.description[locale].trim() && entry.description[locale].trim() !== entry.title[locale].trim() ? (
          <section className="plugin-detail-section" aria-label={t('Description')}>
            <p className="catalog-entry-description">{entry.description[locale]}</p>
          </section>
        ) : null}
        <section className="plugin-detail-section">
          <div className="plugin-section-heading">
            <h2>{t('Source')}</h2>
            <Chip size="sm" variant="soft" color={installationStatus.color}>
              <span role="status">{installationStatus.label}</span>
            </Chip>
          </div>
          {error ? (
            <p role="alert" className="plugin-card-error">
              {errorText(error)}
            </p>
          ) : null}
          <p className="catalog-source">
            {t(locationKey(entry.location))}
            <a href={entry.documentation} target="_blank" rel="noreferrer">
              {t('Service documentation')}
            </a>
          </p>
        </section>
        <section className="plugin-detail-section">
          <h2>{t('This entry will install')}</h2>
          <ul className="grant-rows catalog-plan-rows">
            <li>
              <div className="grant-row-main">
                <p className="grant-row-title catalog-plan-title">
                  <span>{t('MCP service')} ·</span> <strong>{name}</strong>
                  <span> · {t('Catalog version {version}', { version: entry.version })}</span>
                </p>
              </div>
            </li>
          </ul>
          <CommunityField
            label={t('MCP service name')}
            value={name}
            onChange={setName}
            required
            disabled={busy}
            autoFocus
            pattern="p-[A-Za-z0-9_-]{1,30}"
            description={t('Use p- followed by up to 30 letters, digits, underscores or hyphens.')}
          />
          <McpDisplayFields
            value={display}
            defaults={{ name: entry.title, description: entry.description }}
            fallback={{ name, description: '' }}
            busy={busy}
            onChange={setDisplay}
          />
        </section>
        <section className="plugin-detail-section">
          <h2>{t('Service backends')}</h2>
          <h3>{t(locationKey(entry.location))}</h3>
          <p className="section-note">{t('Connection settings are maintained by the platform.')}</p>
          {entry.credentialLabel ? (
            <CommunityField
              label={entry.credentialLabel[locale]}
              value={credential}
              onChange={setCredential}
              type="password"
              autoComplete="new-password"
              required
              disabled={busy}
            />
          ) : (
            <p className="mcp-section-note">{t('No credential required')}</p>
          )}
        </section>
        <section className="plugin-detail-section">
          <h2>{t('Access and publication')}</h2>
          <p className="section-note">{t('Adding a service does not grant access or publish it.')}</p>
        </section>
      </form>
    </CommunityDialog>
  )
}
