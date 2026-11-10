import { mcpDisplayText } from '../../src/domain/mcp-display'
import { CommunityPublicationStatus } from './CommunityPublicationSection'
import { featureVisible } from '../../src/domain/release-visibility'
import { Tabs } from '@heroui/react/tabs'
import CommunityMcpCatalog from './CommunityMcpCatalog'
import CommunityMcpUpdate from './CommunityMcpUpdate'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Card } from '@heroui/react/card'
import type { CommunityMcpSettings, CommunityMcpRemovalImpact } from '../../src/domain/admin-contract'
import { communityMcp, communityMcpRemovalImpact, retryCommunityMcp, updateCommunityMcp } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityDialog from './CommunityDialog'
import McpImport from './CommunityMcpImport'
import McpEditor from './CommunityMcpEditor'
import CommunityIcon from './CommunityIcon'
import CommunityMessage from './CommunityMessage'

export default function CommunityMcpPage() {
  const { t, locale, errorText } = usePlatformLanguage()
  const [rows, setRows] = useState<readonly CommunityMcpSettings[]>()
  const [editing, setEditing] = useState<CommunityMcpSettings | 'new'>()
  const [updating, setUpdating] = useState<CommunityMcpSettings>()
  const [removing, setRemoving] = useState<CommunityMcpRemovalImpact>()
  const [error, setError] = useState<unknown>()
  const [notice, setNotice] = useState<'MCP service saved.' | 'MCP service removed.'>()
  const [importing, setImporting] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [libraryTab, setLibraryTab] = useState('services')
  const testing = rows?.some(
    row =>
      row.catalog?.status === 'testing' ||
      row.catalog?.status === 'preparing' ||
      row.catalogUpdate?.status === 'preparing' ||
      row.catalogUpdate?.status === 'testing',
  )
  useEffect(() => {
    if (!testing) return
    const controller = new AbortController()
    const timer = setInterval(() => {
      void communityMcp(controller.signal)
        .then(setRows)
        .catch(failure => {
          if (!controller.signal.aborted) setError(failure)
        })
    }, 1500)
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [testing])
  useEffect(() => {
    const controller = new AbortController()
    void communityMcp(controller.signal)
      .then(setRows)
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    return () => controller.abort()
  }, [])
  const reviewRemoval = async (name: string) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      setRemoving(await communityMcpRemovalImpact(name))
    } catch (failure) {
      setError(failure)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!removing || pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      setRows(await updateCommunityMcp({ action: 'remove', name: removing.name, revision: removing.revision }))
      setRemoving(undefined)
      setNotice('MCP service removed.')
    } catch (failure) {
      setRemoving(undefined)
      setError(failure)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <div className="community-page">
      <section className="page-heading plugin-page-heading">
        <div>
          <h1>{t('MCP library')}</h1>
          <p>{t('Manage remote tools and grant them to member groups.')}</p>
        </div>
        <div className="plugin-page-actions">
          <Button variant="secondary" onPress={() => setImporting(true)}>
            {t('Import MCP JSON')}
          </Button>
          <Button className="primary-action" onPress={() => setEditing('new')}>
            <CommunityIcon name="plus" size={16} />
            {t('Add MCP service')}
          </Button>
        </div>
      </section>
      {error !== undefined && !removing ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
      {notice ? <CommunityMessage role="status" status="success" title={t(notice)} /> : null}
      <Tabs className="skill-library-tabs library-workspace-tabs" selectedKey={libraryTab} onSelectionChange={key => setLibraryTab(String(key))}>
        <Tabs.ListContainer>
          <Tabs.List aria-label={t('MCP library')}>
            <Tabs.Tab id="services">
              {t('MCP services')}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="catalog">
              {t('MCP catalog')}
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="services">
          <section className="panel plugin-library-panel" aria-label={t('MCP services')}>
            <div className="panel-top">
              <div>
                <div className="panel-title-row">
                  <h2>{t('All MCP services')}</h2>
                  <span className="panel-item-count">{rows?.length ?? '—'}</span>
                </div>
                <p>{t('Adding a service does not grant access or publish it.')}</p>
              </div>
            </div>
            {rows === undefined ? (
              <p className="table-empty" role="status">
                {t('Loading…')}
              </p>
            ) : rows.length === 0 ? (
              <p className="table-empty">{t('No MCP services yet')}</p>
            ) : (
              <div className="plugin-card-grid library-compact-grid">
                {rows.map(row => (
                  <Card key={row.name} className="plugin-library-card mcp-service-card">
                    <Card.Header>
                      <div className="library-card-heading">
                        <Card.Title>{mcpDisplayText(row, locale).name}</Card.Title>
                        <CommunityIcon name="chevron" size={14} />
                      </div>
                      {mcpDisplayText(row, locale).name !== row.name ? <Card.Description>{row.name}</Card.Description> : null}
                      {mcpDisplayText(row, locale).description ? <Card.Description>{mcpDisplayText(row, locale).description}</Card.Description> : null}
                    </Card.Header>
                    {row.catalog || row.catalogUpdate ? (
                      <Card.Content>
                        {row.catalog ? (
                          <p role="status">
                            {t(
                              row.catalog.status === 'preparing'
                                ? 'Preparing dependencies…'
                                : row.catalog.status === 'testing'
                                  ? 'Testing imported service…'
                                  : row.catalog.status === 'ready'
                                    ? 'Import ready'
                                    : 'Import failed',
                            )}
                          </p>
                        ) : null}
                        {row.catalogUpdate ? (
                          <p role="status">
                            {t(
                              row.catalogUpdate.status === 'applied'
                                ? 'Catalog update applied'
                                : row.catalogUpdate.status === 'failed'
                                  ? 'Catalog update failed. Current service retained.'
                                  : row.catalogUpdate.status === 'preparing'
                                    ? 'Preparing catalog update…'
                                    : 'Testing catalog update…',
                            )}
                          </p>
                        ) : null}
                      </Card.Content>
                    ) : null}
                    {row.published &&
                    (row.testStatus !== 'passed' ||
                      (row.catalog !== undefined && row.catalog.status !== 'ready') ||
                      (row.preparation !== undefined && row.preparation.stage !== 'ready')) ? (
                      <p className="plugin-card-error">{t('Service preparation or connection is not ready.')}</p>
                    ) : null}
                    <Card.Footer className="plugin-card-status">
                      <CommunityPublicationStatus
                        published={row.published}
                        unavailable={
                          row.testStatus !== 'passed' ||
                          (row.catalog !== undefined && row.catalog.status !== 'ready') ||
                          (row.preparation !== undefined && row.preparation.stage !== 'ready')
                        }
                      />
                      {row.availableCatalogVersion ? (
                        <Button
                          className="relative z-10"
                          size="sm"
                          variant="secondary"
                          isDisabled={row.catalogUpdate?.status === 'preparing' || row.catalogUpdate?.status === 'testing'}
                          onPress={() => setUpdating(row)}
                        >
                          {t('Review catalog update')}
                        </Button>
                      ) : null}
                      {row.catalog?.status === 'failed' ? (
                        <Button
                          className="relative z-10"
                          size="sm"
                          variant="secondary"
                          onPress={() => {
                            void retryCommunityMcp(row.name).then(setRows).catch(setError)
                          }}
                        >
                          {t('Retry import')}
                        </Button>
                      ) : null}
                      <Button
                        className="relative z-10 ms-auto"
                        size="sm"
                        variant="tertiary"
                        onPress={() => {
                          setError(undefined)
                          void reviewRemoval(row.name)
                        }}
                      >
                        {t('Remove')}
                      </Button>
                    </Card.Footer>
                    <Button size="sm" variant="tertiary" className="plugin-details-action" aria-label={t('Edit')} onPress={() => setEditing(row)} />
                  </Card>
                ))}
              </div>
            )}
            <div className="panel-footer plugin-library-note">
              <CommunityIcon name="shield" size={16} />
              <span>{t('MCP changes take effect immediately. Tools update on the next agent request.')}</span>
            </div>
          </section>
        </Tabs.Panel>
        <Tabs.Panel id="catalog">
          <CommunityMcpCatalog
            rows={rows}
            onImported={next => {
              setRows(next)
              setLibraryTab('services')
            }}
          />
        </Tabs.Panel>
      </Tabs>
      {updating ? (
        <CommunityMcpUpdate
          service={updating}
          onClose={() => setUpdating(undefined)}
          onStarted={next => {
            setRows(next)
            setUpdating(undefined)
          }}
        />
      ) : null}
      {importing ? (
        <McpImport
          onRefreshed={next => setRows(rows => rows?.map(row => (row.name === next.name ? next : row)))}
          onClose={() => setImporting(false)}
          onSaved={next => {
            setRows(next)
            setNotice('MCP service saved.')
          }}
        />
      ) : null}
      {editing ? (
        <McpEditor
          onRefreshed={next => setRows(rows => rows?.map(row => (row.name === next.name ? next : row)))}
          value={editing}
          onClose={() => setEditing(undefined)}
          onSaved={next => {
            setRows(next)
            setNotice('MCP service saved.')
          }}
        />
      ) : null}
      {removing ? (
        <CommunityDialog
          title={t('Remove MCP service')}
          busy={busy}
          onClose={() => setRemoving(undefined)}
          footer={
            <>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setRemoving(undefined)}>
                {t('Cancel')}
              </Button>
              <Button
                variant="danger"
                isDisabled={busy}
                onPress={() => {
                  void remove()
                }}
              >
                {t('Confirm action')}
              </Button>
            </>
          }
        >
          {featureVisible('experts') && removing.experts.length ? (
            <p>{t('Will be removed from experts: {names}', { names: removing.experts.map(row => row.name).join(', ') })}</p>
          ) : null}
          <p>{t('Remove {name}? Its grants and access will end immediately.', { name: removing.name })}</p>
          {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
        </CommunityDialog>
      ) : null}
    </div>
  )
}
