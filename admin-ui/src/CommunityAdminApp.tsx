import { useContributionCount } from './useContributionCount';
import { Chip } from '@heroui/react/chip';
import { usePlatformLanguage } from './CommunityLanguage';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Avatar } from '@heroui/react/avatar';
import { Breadcrumbs } from '@heroui/react/breadcrumbs';
import type { CommunityManagementSession } from '../../src/domain/admin-contract';
import { communitySession } from './community-api';
import CommunityIcon from './CommunityIcon';
import CommunityPageBoundary from './CommunityPageBoundary';
import CommunityHeaderControls from './CommunityHeaderControls';
import CommunityMessage from './CommunityMessage';
const Records = lazy(() => import('./CommunityExecutionRecords'));
const Skills = lazy(() => import('./CommunitySkillsPage'));
const Mcp = lazy(() => import('./CommunityMcpPage'));
const Plugins = lazy(() => import('./CommunityPluginsPage'));
const Groups = lazy(() => import('./CommunityGroupsPage'));
const Accounts = lazy(() => import('./CommunityAccountsPage'));
const Models = lazy(() => import('./CommunityModelsPanel'));
const Updates = lazy(() => import('./CommunitySystemUpdatePanel'));
const routes = [ ['accounts', 'Account management'], ['groups', 'Group management'], ['plugins', 'Plugin library'], ['mcp', 'MCP library'], ['skills', 'Skill library'], ['execution-records', 'Platform execution records'], ['models', 'Model management'], ['settings', 'System settings'] ] as const;
export default function CommunityAdminApp() {
  const { t, errorText } = usePlatformLanguage();
  const contributionCount = useContributionCount();
  const [session, setSession] = useState<CommunityManagementSession>();
  const [error, setError] = useState<unknown>();
  const [open, setOpen] = useState(false);
  const route = location.pathname.endsWith('/mcp') ? 'mcp' : location.pathname.endsWith('/execution-records') ? 'execution-records' : location.pathname.endsWith('/skills') ? 'skills' : location.pathname.endsWith('/plugins') ? 'plugins' : location.pathname.endsWith('/groups') ? 'groups' : location.pathname.endsWith('/models') ? 'models' : location.pathname.endsWith('/settings') ? 'settings' : 'accounts';
  useEffect(() => { document.title = `${t(routes.find(([id]) => id === route)![1])} · dsh-phalanx`; }, [route, t]);
  useEffect(() => {
    const legacy = location.hash === '#model-settings' ? 'models' : location.hash === '#system-update' ? 'settings' : undefined;
    if (legacy) { location.replace(`/admin/${legacy}`); return; }
    const controller = new AbortController();
    void communitySession(controller.signal).then(setSession).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, []);
  return <div className="admin-shell app-shell">
    <div className="mobile-bar"><a href="/admin" className="wordmark">dsh-phalanx</a><Button size="sm" variant="secondary" aria-expanded={open} aria-controls="admin-sidebar" onPress={() => setOpen(value => !value)}>{t(open ? 'Close navigation' : 'Open navigation')}</Button></div>
    <aside id="admin-sidebar" className={`admin-sidebar sidebar${open ? ' is-open' : ''}`}>
      <a className="brand" href="/admin"><div className="brand-mark" aria-hidden="true"><CommunityIcon name="models" size={18}/></div><div><strong>dsh-phalanx</strong><span>{t('Administration')}</span></div></a>
      <p className="nav-caption">{t('Administration')}</p>
      <nav className="nav-list" aria-label={t('Management')}>{routes.map(([id, title]) => <a className={`nav-item${route === id ? ' active' : ''}`} key={id} href={`/admin/${id}`} aria-current={route === id ? 'page' : undefined}><CommunityIcon name={id === 'mcp' ? 'plugins' : id === 'execution-records' ? 'activity' : id} size={18}/><span>{t(title)}</span>{id === 'skills' && contributionCount > 0 ? <Chip size="sm" variant="soft" aria-hidden="true">{contributionCount}</Chip> : null}</a>)}</nav>
      <div className="sidebar-bottom">
        <div className="sidebar-profile"><Avatar size="sm" color="accent" variant="soft" aria-hidden="true"><Avatar.Fallback>{session?.username.slice(0, 1).toUpperCase() ?? '·'}</Avatar.Fallback></Avatar><div><strong>{session?.username ?? t('Loading…')}</strong><small>{t('Administrator')}</small></div><form method="post" action="/logout"><Button isIconOnly variant="tertiary" size="sm" type="submit" aria-label={t('Sign out')}><CommunityIcon name="logout" size={17}/></Button></form></div>
        <a className="sidebar-usage-link" href="/enter" aria-label={t('Open DSH')}><span>{t('Open DSH')}</span><CommunityIcon name="arrow" size={16}/></a>
      </div>
    </aside>
    <div className="admin-workspace main-area"><header className="topbar"><nav aria-label={t('Breadcrumb')}><Breadcrumbs><Breadcrumbs.Item href="/admin">dsh-phalanx</Breadcrumbs.Item><Breadcrumbs.Item href="/admin">{t('Administration')}</Breadcrumbs.Item><Breadcrumbs.Item>{t(routes.find(([id]) => id === route)![1])}</Breadcrumbs.Item></Breadcrumbs></nav><div className="topbar-actions"><CommunityHeaderControls/><span className="session-pill"><strong>{session?.username ?? '…'}</strong>{t('Administrator')}</span></div></header>
    <main className="admin-content content-wrap" id="main-content">{error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error, 'Unable to load management session')}/> : <CommunityPageBoundary><Suspense fallback={<p role="status">{t('Loading management page…')}</p>}>
      {route === 'mcp' ? <Mcp/> : route === 'execution-records' ? <Records/> : route === 'skills' ? <Skills/> : route === 'plugins' ? <Plugins/> : route === 'groups' ? <Groups/> : route === 'accounts' ? <Accounts session={session}/> : route === 'models' ? <Models onConfigured={configured => setSession(viewer => viewer ? { ...viewer, modelState: configured ? 'configured' : 'unconfigured' } : viewer)}/> : <Updates/>}
    </Suspense></CommunityPageBoundary>}</main><footer className="admin-footer app-footer"><span>dsh-phalanx</span><span>{t('A space for every teammate.')}</span></footer></div>
  </div>;
}
