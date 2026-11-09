import { featureVisible } from '../../src/domain/release-visibility'
import CommunityPluginAddDialog from './CommunityPluginAddDialog'
import { pluginSourceLabel, pluginStageLabels as stageLabels, pluginVersionLabel } from './community-plugin-stage'
import CommunitySuitesPage from './CommunitySuitesPage'
import { useSuiteOriginName } from './useSuiteOriginName'
import CommunityPluginDependencies from './CommunityPluginDependencies'
import CommunityLibraryMaintenance from './CommunityLibraryMaintenance'
import CommunityContributions from './CommunityContributions'
import CommunityPluginAccess from './CommunityPluginAccess'
import CommunityPluginPublication from './CommunityPluginPublication'
import CommunityPluginUpstreams from './CommunityPluginUpstreams'
import CommunityPluginChanges from './CommunityPluginChanges'
import CommunityPluginUploadDialog from './CommunityPluginUploadDialog'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Card } from '@heroui/react/card'
import { Chip } from '@heroui/react/chip'
import { Tabs } from '@heroui/react/tabs'
import CommunityIcon from './CommunityIcon'
import type { CommunityPluginView } from '../../src/domain/admin-contract'
import { platformError } from '../../src/domain/platform-copy'
import { retryCommunityPlugin, communityPlugins } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityDialog from './CommunityDialog'
import CommunityMessage from './CommunityMessage'
import CommunitySelect from './CommunitySelect'

export default function CommunityPluginsPage() {
  const { t, locale, errorText } = usePlatformLanguage()
  const [libraryTab, setLibraryTab] = useState(() => (new URLSearchParams(window.location.search).get('tab') === 'catalog' ? 'catalog' : 'plugins'))
  const [plugins, setPlugins] = useState<readonly CommunityPluginView[]>()
  const originName = useSuiteOriginName(locale, plugins?.some(row => Boolean(row.suiteOrigin)) ?? false)
  const [publicationFilter, setPublicationFilter] = useState('all')
  const visiblePlugins =
    plugins?.filter(plugin => publicationFilter === 'all' || (publicationFilter === 'published' ? plugin.published : !plugin.published)) ?? []
  const [uploading, setUploading] = useState(false)
  const [adding, setAdding] = useState(false)
  const accessCloseGuard = useRef<((action: () => void) => void) | undefined>(undefined)
  const dependencyCloseGuard = useRef<((action: () => void) => void) | undefined>(undefined)
  const closeDetails = () => {
    const close = () => setSelected(undefined)
    const access = () => {
      if (accessCloseGuard.current) accessCloseGuard.current(close)
      else close()
    }
    if (dependencyCloseGuard.current) dependencyCloseGuard.current(access)
    else access()
  }
  const [selected, setSelected] = useState<string>()
  const [detailTab, setDetailTab] = useState('basic')
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState<unknown>()
  const [retrying, setRetrying] = useState<string>()
  const pending = useRef(false)
  const refresh = () => setRevision(value => value + 1)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const items = await communityPlugins(controller.signal)
        if (controller.signal.aborted) return
        setPlugins(items)
        setError(undefined)
        if (
          items.some(
            item =>
              item.checking?.length ||
              (item.stage !== 'available' && item.stage !== 'failed') ||
              (item.replacement && item.replacement.stage !== 'available' && item.replacement.stage !== 'failed'),
          )
        )
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
  const retry = async (plugin: CommunityPluginView) => {
    if (pending.current) return
    pending.current = true
    setRetrying(plugin.packageName)
    try {
      await retryCommunityPlugin(`${plugin.packageName}@${plugin.version}`)
      refresh()
    } catch (failure) {
      setError(failure)
    } finally {
      pending.current = false
      setRetrying(undefined)
    }
  }
  const detail = plugins?.find(plugin => plugin.packageName === selected)
  const stageText = (plugin: CommunityPluginView) =>
    t(
      plugin.incompatible
        ? 'Incompatible with the current version'
        : plugin.source === 'upload' && plugin.stage === 'downloading'
          ? 'Preparing uploaded archive'
          : stageLabels[plugin.stage],
    )
  const failureText = (plugin: CommunityPluginView) => platformError(locale, { code: plugin.failureCode, error: '' })
  const integrity = detail?.integrity ? (
    <details className="plugin-integrity">
      <summary>{t('Integrity (sha512)')}</summary>
      <code>{detail.integrity}</code>
    </details>
  ) : null
  return (
    <div className="community-page">
      <section className="page-heading plugin-page-heading">
        <div>
          <h1>{t('Plugin library')}</h1>
          <p>{t('Prepare plugins before making them available to members.')}</p>
        </div>
        <div className="plugin-page-actions">
          <Button className="primary-action" onPress={() => setAdding(true)}>
            <CommunityIcon name="plus" size={16} />
            {t('Add plugin')}
          </Button>
          <Button variant="secondary" onPress={() => setUploading(true)}>
            {t('Upload plugin archive')}
          </Button>
        </div>
      </section>
      {error !== undefined ? (
        <>
          <CommunityMessage role="alert" status="danger" title={errorText(error)} />
          <Button variant="secondary" onPress={refresh}>
            {t('Reload plugins')}
          </Button>
        </>
      ) : null}
      <Tabs
        className="skill-library-tabs library-workspace-tabs"
        selectedKey={libraryTab}
        onSelectionChange={key => {
          setLibraryTab(String(key))
          window.history.replaceState(null, '', key === 'catalog' ? '/admin/plugins?tab=catalog' : '/admin/plugins')
          refresh()
        }}
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label={t('Plugin library')}>
            <Tabs.Tab id="plugins">
              {t('Plugins')}
              <Tabs.Indicator />
            </Tabs.Tab>
            {featureVisible('contributions') ? (
              <Tabs.Tab id="contributions">
                {t('Member contributions')}
                <Tabs.Indicator />
              </Tabs.Tab>
            ) : null}
            <Tabs.Tab id="catalog">
              {t('Plugin catalog')}
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="plugins">
          <section className="panel plugin-library-panel" aria-label={t('All plugins')}>
            <div className="panel-top panel-filter-header">
              <div>
                <div className="panel-title-row">
                  <h2>{t('All plugins')}</h2>
                  <span className="panel-item-count">{t('{count} plugins', { count: plugins ? visiblePlugins.length : '—' })}</span>
                </div>
                <p>{t('Review plugin versions, readiness and publication.')}</p>
              </div>
              <CommunitySelect
                className="panel-filter"
                hideLabel
                label={t('Filter by publication')}
                value={publicationFilter}
                onChange={setPublicationFilter}
                options={[
                  { id: 'all', label: t('All plugins') },
                  { id: 'published', label: t('Published to marketplace') },
                  { id: 'unpublished', label: t('Not published') },
                ]}
              />
            </div>
            {plugins === undefined ? (
              <p className="table-empty" role="status">
                {t('Loading…')}
              </p>
            ) : plugins.length === 0 ? (
              <Card className="plugin-library-empty" variant="transparent">
                <Card.Header>
                  <span className="plugin-card-icon" aria-hidden="true">
                    <CommunityIcon name="plugins" size={22} />
                  </span>
                  <Card.Title>{t('No plugins yet')}</Card.Title>
                  <Card.Description>{t('Add an npm package or a GitHub repository to start the precheck.')}</Card.Description>
                </Card.Header>
              </Card>
            ) : visiblePlugins.length === 0 ? (
              <Card className="plugin-library-empty" variant="transparent">
                <Card.Header>
                  <Card.Title>{t('No plugins match this filter.')}</Card.Title>
                  <Card.Description>{t('Choose another publication status to view plugins.')}</Card.Description>
                </Card.Header>
                <Card.Footer>
                  <Button variant="secondary" onPress={() => setPublicationFilter('all')}>
                    {t('Show all plugins')}
                  </Button>
                </Card.Footer>
              </Card>
            ) : (
              <div className="plugin-card-grid library-compact-grid">
                {visiblePlugins.map(plugin => (
                  <Card key={plugin.packageName} className="plugin-library-card">
                    <Card.Header>
                      <div className="library-card-heading">
                        <Card.Title>{plugin.title}</Card.Title>
                        <CommunityIcon name="chevron" size={14} />
                      </div>
                      <p className="plugin-summary-meta">
                        <span>{pluginSourceLabel(plugin, t)}</span> · <span>{pluginVersionLabel(plugin.version, plugin.sourceCommit)}</span>
                      </p>
                      {plugin.suiteOrigin ? (
                        <Chip size="sm" variant="soft" color="accent">
                          {t('From “{name}”', { name: originName(plugin.suiteOrigin) })}
                        </Chip>
                      ) : null}
                      {plugin.description ? <Card.Description>{plugin.description}</Card.Description> : null}
                    </Card.Header>
                    <Card.Content>
                      {plugin.publicationPaused ? <p className="plugin-card-error">{t('Publication paused until a compatible version is selected.')}</p> : null}
                      {plugin.invalidAccessEntries?.length ? (
                        <p className="plugin-card-error">{t('Missing entry IDs: {ids}', { ids: plugin.invalidAccessEntries.join(', ') })}</p>
                      ) : null}
                      {plugin.checking?.length ? <p className="plugin-card-hint">{t('Checking capabilities…')}</p> : null}
                      {plugin.failures?.length ? (
                        <p className="plugin-card-error">{t('Load failed for {count} members.', { count: plugin.failures.length })}</p>
                      ) : null}
                      {plugin.failureCode ? <p className="plugin-card-error">{failureText(plugin)}</p> : null}
                    </Card.Content>
                    <Card.Footer className="plugin-card-status" role="status">
                      <span
                        className={
                          plugin.incompatible || plugin.stage === 'failed'
                            ? 'plugin-stage is-failed'
                            : plugin.stage === 'available'
                              ? 'plugin-stage is-available'
                              : 'plugin-stage is-preparing'
                        }
                      >
                        <span aria-hidden="true" />
                        {stageText(plugin)}
                      </span>
                      {plugin.published ? (
                        <Chip size="sm" variant="soft" color="success">
                          {t('Published')}
                        </Chip>
                      ) : null}
                    </Card.Footer>
                    <Button
                      variant="tertiary"
                      size="sm"
                      onPress={() => {
                        setDetailTab('basic')
                        setSelected(plugin.packageName)
                      }}
                      aria-label={t('View plugin {name}', { name: plugin.packageName })}
                      className="plugin-details-action"
                    />
                  </Card>
                ))}
              </div>
            )}
            <div className="panel-footer plugin-library-note">
              <CommunityIcon name="shield" size={16} />
              <span>{t('Adding a plugin does not grant it to ordinary groups or publish it to the marketplace.')}</span>
            </div>
          </section>
        </Tabs.Panel>
        {featureVisible('contributions') ? (
          <Tabs.Panel id="contributions">
            <CommunityContributions kind="plugin" onChanged={refresh} />
          </Tabs.Panel>
        ) : null}
        <Tabs.Panel id="catalog">
          <CommunitySuitesPage category="plugin" />
        </Tabs.Panel>
      </Tabs>
      {uploading ? (
        <CommunityPluginUploadDialog
          onClose={() => setUploading(false)}
          onAdded={() => {
            setUploading(false)
            refresh()
          }}
        />
      ) : null}
      {adding ? (
        <CommunityPluginAddDialog
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false)
            refresh()
          }}
        />
      ) : null}
      {detail ? (
        <CommunityDialog drawer drawerClassName="plugin-drawer" title={detail.title} closeLabel={t('Close plugin details')} onClose={closeDetails}>
          <div className="drawer-identity plugin-identity">
            <span className="plugin-card-icon" aria-hidden="true">
              <CommunityIcon name="plugins" size={22} />
            </span>
            <div>
              <strong>{detail.packageName}</strong>
              <span>
                {pluginSourceLabel(detail, t)} · {pluginVersionLabel(detail.version, detail.sourceCommit)}
              </span>
            </div>
            <Chip
              size="sm"
              variant="soft"
              color={detail.incompatible || detail.stage === 'failed' ? 'danger' : detail.stage === 'available' ? 'success' : 'warning'}
            >
              <span role="status">{stageText(detail)}</span>
            </Chip>
          </div>
          {detail.description ? <p className="plugin-summary-description">{detail.description}</p> : null}
          <div className="plugin-detail-sections">
            {detail.checking?.length ? <CommunityMessage status="default" title={t('Checking capabilities…')} /> : null}
            {detail.failureCode ? <CommunityMessage role="alert" status="danger" title={failureText(detail)} /> : null}
            {detail.stage === 'failed' ? (
              <div>
                <Button
                  variant="secondary"
                  isDisabled={retrying !== undefined}
                  onPress={() => {
                    void retry(detail)
                  }}
                >
                  {t('Retry precheck')}
                </Button>
              </div>
            ) : null}
            {detail.failures?.length ? (
              <details className="plugin-member-diagnostics">
                <summary>{t('Load failed for {count} members.', { count: detail.failures.length })}</summary>
                <ul>
                  {detail.failures.map(failure => (
                    <li key={failure.username}>
                      <strong>{failure.username}</strong> · {platformError(locale, { code: failure.code, error: '' })}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <Tabs className="plugin-detail-tabs" selectedKey={detailTab} onSelectionChange={key => setDetailTab(String(key))} variant="secondary">
              <Tabs.ListContainer>
                <Tabs.List aria-label={t('Plugin details')}>
                  <Tabs.Tab id="basic">
                    {t('Basic settings')}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                  <Tabs.Tab id="dependencies">
                    {t('Runtime dependencies')}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                  <Tabs.Tab id="access">
                    {t('Access settings')}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs.ListContainer>
              <Tabs.Panel id="dependencies" className="plugin-settings-panel" shouldForceMount>
                <CommunityPluginDependencies
                  key={detail.packageName}
                  detail={detail}
                  onChanged={refresh}
                  onCloseGuard={guard => {
                    dependencyCloseGuard.current = guard
                  }}
                />
              </Tabs.Panel>
              <Tabs.Panel id="access" className="plugin-settings-panel" shouldForceMount>
                <CommunityPluginUpstreams key={detail.packageName} packageName={detail.packageName} onChanged={refresh} />
                <CommunityPluginAccess
                  key={detail.packageName + '-access'}
                  packageName={detail.packageName}
                  onChanged={refresh}
                  onSaveFailed={() => setDetailTab('access')}
                  onCloseGuard={guard => {
                    accessCloseGuard.current = guard
                  }}
                />
              </Tabs.Panel>
              <Tabs.Panel id="basic" className="plugin-settings-panel" shouldForceMount>
                <section className="plugin-detail-section" aria-label={t('Publication')}>
                  <div className="plugin-section-heading">
                    <h2>{t('Publication')}</h2>
                    <Chip size="sm" variant="soft" color={detail.published ? 'success' : 'default'}>
                      {t(detail.published ? 'Published' : 'Not published')}
                    </Chip>
                  </div>
                  <p>{t('{count} member selections', { count: detail.selectedMembers ?? 0 })}</p>
                  {detail.publicationPaused ? <p>{t('Publication paused until a compatible version is selected.')}</p> : null}
                  <CommunityPluginPublication plugin={detail} onChanged={refresh} />
                </section>
                {detail.suiteOrigin ? (
                  <>
                    <p className="plugin-catalog-origin">
                      {t('From “{name}”', { name: originName(detail.suiteOrigin) })} · <a href="/admin/plugins?tab=catalog">{t('Plugin catalog')}</a>
                    </p>
                    {integrity}
                  </>
                ) : (
                  <CommunityPluginChanges
                    plugin={detail}
                    onChanged={removed => {
                      if (removed) setSelected(undefined)
                      refresh()
                    }}
                  >
                    <CommunityLibraryMaintenance
                      kind="plugin"
                      name={detail.packageName}
                      provenance={detail.provenance}
                      revision={detail.maintenanceRevision ?? ''}
                      onChanged={refresh}
                    />
                    {integrity}
                  </CommunityPluginChanges>
                )}
              </Tabs.Panel>
            </Tabs>
          </div>
        </CommunityDialog>
      ) : null}
    </div>
  )
}
