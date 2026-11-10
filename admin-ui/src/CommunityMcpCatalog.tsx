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
                  <p className="plugin-summary-meta">
                    {t(locationKey(entry.location))} · v{entry.version}
                  </p>
                  <Card.Description>{entry.description[locale]}</Card.Description>
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
  onClose,
  onImported,
}: {
  entry: CommunityMcpCatalogEntry
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
      drawerClassName="plugin-drawer library-form-drawer mcp-service-drawer"
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
      <p className="plugin-summary-description">{entry.description[locale]}</p>
      {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
      <form
        id={id}
        className="plugin-settings-panel mcp-catalog-import"
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        <section className="plugin-detail-section" aria-label={t('Service details')}>
          <div className="plugin-section-heading">
            <h2>{t('Service details')}</h2>
            <a href={entry.documentation} target="_blank" rel="noreferrer">
              {t('Service documentation')}
            </a>
          </div>
          <div className="plugin-section-heading">
            <p>{t('Catalog version {version}', { version: entry.version })}</p>
            <Chip size="sm" variant="soft">
              {t(locationKey(entry.location))}
            </Chip>
          </div>
          <p className="mcp-section-note">{t('Connection settings are maintained by the platform.')}</p>
        </section>
        <section className="plugin-detail-section" aria-label={t('Access settings')}>
          <h2>{t('Access settings')}</h2>
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
        <p className="mcp-catalog-import-note">
          <CommunityIcon name="shield" size={16} />
          <span>{t('Adding a service does not grant access or publish it.')}</span>
        </p>
      </form>
    </CommunityDialog>
  )
}
