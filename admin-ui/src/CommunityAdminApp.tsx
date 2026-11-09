import { featureVisible } from '../../src/domain/release-visibility'
const AccountSwitcher = lazy(() => import('./CommunityAccountSwitcher'))
const UsageRecords = lazy(() => import('./CommunityUsageRecords'))
import { usePlatformLanguage } from './CommunityLanguage'
import { lazy, Suspense, useEffect, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Tooltip } from '@heroui/react/tooltip'
import { Avatar } from '@heroui/react/avatar'
import type { CommunityManagementSession } from '../../src/domain/admin-contract'
import { communitySession, CommunityApiRequestError } from './community-api'
import CommunityIcon from './CommunityIcon'
import CommunityPageBoundary from './CommunityPageBoundary'
import CommunityHeaderControls from './CommunityHeaderControls'
import CommunityMessage from './CommunityMessage'
const Experts = lazy(() => import('./CommunityExpertsPage'))
const Skills = lazy(() => import('./CommunitySkillsPage'))
const Mcp = lazy(() => import('./CommunityMcpPage'))
const Dependencies = lazy(() => import('./CommunityRuntimeDependencies'))
const Plugins = lazy(() => import('./CommunityPluginsPage'))
const Groups = lazy(() => import('./CommunityGroupsPage'))
const Accounts = lazy(() => import('./CommunityAccountsPage'))
const Models = lazy(() => import('./CommunityModelsPanel'))
const SystemSettings = lazy(() => import('./CommunitySystemSettingsPage'))
const navIcons = {
  accounts: 'user',
  groups: 'groups',
  plugins: 'plugins',
  mcp: 'mcp',
  skills: 'skills',
  experts: 'experts',
  'runtime-dependencies': 'package',
  'usage-records': 'usage',
  models: 'models',
  settings: 'settings',
} as const
const routes = [
  ['accounts', 'Account management'],
  ['groups', 'Group management'],
  ['plugins', 'Plugin library'],
  ['mcp', 'MCP library'],
  ['skills', 'Skill library'],
  ['experts', 'Expert library'],
  ['runtime-dependencies', 'Runtime dependencies'],
  ['usage-records', 'Usage records'],
  ['models', 'Model management'],
  ['settings', 'System settings'],
] as const
export default function CommunityAdminApp() {
  const { t, errorText } = usePlatformLanguage()
  const [session, setSession] = useState<CommunityManagementSession>()
  const [error, setError] = useState<unknown>()
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const route =
    featureVisible('usage') && location.pathname.endsWith('/usage-records')
      ? 'usage-records'
      : featureVisible('experts') && location.pathname.endsWith('/experts')
        ? 'experts'
        : location.pathname.endsWith('/runtime-dependencies')
          ? 'runtime-dependencies'
          : location.pathname.endsWith('/mcp')
            ? 'mcp'
            : location.pathname.endsWith('/skills')
              ? 'skills'
              : location.pathname.endsWith('/plugins')
                ? 'plugins'
                : location.pathname.endsWith('/groups')
                  ? 'groups'
                  : location.pathname.endsWith('/models')
                    ? 'models'
                    : location.pathname.endsWith('/settings')
                      ? 'settings'
                      : 'accounts'
  useEffect(() => {
    document.title = `${t(routes.find(([id]) => id === route)![1])} · dsh-phalanx`
  }, [route, t])
  useEffect(() => {
    const legacy = location.hash === '#model-settings' ? 'models' : location.hash === '#system-update' ? 'settings' : undefined
    if (legacy) {
      location.replace(`/admin/${legacy}`)
      return
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const current = await communitySession(controller.signal)
        if (!controller.signal.aborted) {
          setSession(current)
          setError(undefined)
        }
      } catch (failure) {
        if (controller.signal.aborted) return
        setError(failure)
        if (failure instanceof CommunityApiRequestError && failure.code === 'platform-database-unavailable')
          timer = setTimeout(() => {
            void load()
          }, 3000)
      }
    }
    void load()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])
  return (
    <div className="admin-shell app-shell">
      <div className="mobile-bar">
        <a href="/admin" className="wordmark">
          dsh-phalanx
        </a>
        <Button size="sm" variant="secondary" aria-expanded={open} aria-controls="admin-sidebar" onPress={() => setOpen(value => !value)}>
          {t(open ? 'Close navigation' : 'Open navigation')}
        </Button>
      </div>
      <aside id="admin-sidebar" className={`admin-sidebar sidebar${open ? ' is-open' : ''}`}>
        <a className="brand" href="/admin">
          <div className="brand-mark" aria-hidden="true">
            <CommunityIcon name="brand" size={18} />
          </div>
          <div>
            <strong>dsh-phalanx</strong>
            <span>{t('Administration')}</span>
          </div>
        </a>
        <nav className="nav-list admin-nav-list" aria-label={t('Management')}>
          {routes
            .filter(([id]) => (id === 'experts' ? featureVisible('experts') : id === 'usage-records' ? featureVisible('usage') : true))
            .map(([id, title]) => (
              <a className={`nav-item${route === id ? ' active' : ''}`} key={id} href={`/admin/${id}`} aria-current={route === id ? 'page' : undefined}>
                <CommunityIcon name={navIcons[id]} size={18} />
                <span>{t(title)}</span>
              </a>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-actions">
            <button type="button" className="sidebar-action" onClick={() => setSwitching(true)}>
              <CommunityIcon name="switch" size={16} />
              <span>{t('Switch accounts')}</span>
            </button>
            <a className="sidebar-action" href="/enter" target="_blank" rel="noopener">
              <CommunityIcon name="external" size={16} />
              <span>{t('Open {name} DSH', { name: session?.username ?? '…' })}</span>
            </a>
          </div>
          <div className="sidebar-profile">
            <Avatar size="sm" color="accent" variant="soft" aria-hidden="true">
              <Avatar.Fallback>{session?.username.slice(0, 1).toUpperCase() ?? '·'}</Avatar.Fallback>
            </Avatar>
            <div>
              <strong>{session?.username ?? t('Loading…')}</strong>
              <small>{t('Administrator')}</small>
            </div>
            <form method="post" action="/logout">
              <Tooltip delay={300}>
                <Button isIconOnly variant="ghost" size="sm" type="submit" aria-label={t('Sign out')}>
                  <CommunityIcon name="logout" size={16} />
                </Button>
                <Tooltip.Content>{t('Sign out')}</Tooltip.Content>
              </Tooltip>
            </form>
          </div>
        </div>
      </aside>
      <Suspense fallback={null}>{switching ? <AccountSwitcher onClose={() => setSwitching(false)} /> : null}</Suspense>
      <div className="admin-workspace main-area">
        <header className="topbar">
          <span className="admin-current-page">{t(routes.find(([id]) => id === route)![1])}</span>
          <div className="topbar-actions">
            <CommunityHeaderControls />
          </div>
        </header>
        <main className="admin-content content-wrap" id="main-content">
          {error !== undefined ? (
            <CommunityMessage role="alert" status="danger" title={errorText(error, 'Unable to load management session')} />
          ) : (
            <CommunityPageBoundary>
              <Suspense fallback={<p role="status">{t('Loading management page…')}</p>}>
                {route === 'usage-records' ? (
                  <UsageRecords />
                ) : route === 'experts' ? (
                  <Experts />
                ) : route === 'runtime-dependencies' ? (
                  <Dependencies />
                ) : route === 'mcp' ? (
                  <Mcp />
                ) : route === 'skills' ? (
                  <Skills />
                ) : route === 'plugins' ? (
                  <Plugins />
                ) : route === 'groups' ? (
                  <Groups />
                ) : route === 'accounts' ? (
                  <Accounts session={session} />
                ) : route === 'models' ? (
                  <Models
                    onConfigured={configured => setSession(viewer => (viewer ? { ...viewer, modelState: configured ? 'configured' : 'unconfigured' } : viewer))}
                  />
                ) : (
                  <SystemSettings />
                )}
              </Suspense>
            </CommunityPageBoundary>
          )}
        </main>
        <footer className="admin-footer app-footer">
          <span>dsh-phalanx</span>
          <span>{t('A space for every teammate.')}</span>
        </footer>
      </div>
    </div>
  )
}
