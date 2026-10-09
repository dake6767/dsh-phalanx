import { usePlatformLanguage } from './CommunityLanguage';
import type { PlatformLanguagePreference } from '../../src/domain/platform-language';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityManagementSession } from '../../src/domain/admin-contract';
import { communitySession } from './community-api';
import CommunityIcon from './CommunityIcon';
import CommunityPageBoundary from './CommunityPageBoundary';
import CommunitySelect from './CommunitySelect';
import CommunityMessage from './CommunityMessage';
const Groups = lazy(() => import('./CommunityGroupsPage'));
const Accounts = lazy(() => import('./CommunityAccountsPage'));
const Models = lazy(() => import('./CommunityModelsPanel'));
const Updates = lazy(() => import('./CommunitySystemUpdatePanel'));
type Appearance = 'system' | 'light' | 'dark';
declare global { interface Window { dshPhalanxAppearance?: { get: () => Appearance; set: (value: Appearance) => void } } }
const appearances = [{ id: 'system', label: 'System appearance' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }] as const;
function AppearanceSelect() {
  const { t, preference, setPreference } = usePlatformLanguage();
  const [value, setValue] = useState<Appearance>(() => window.dshPhalanxAppearance?.get() ?? 'system');
  useEffect(() => {
    const sync = (event: Event) => setValue((event as CustomEvent<Appearance>).detail);
    addEventListener('dsh-phalanx:appearance', sync); return () => removeEventListener('dsh-phalanx:appearance', sync);
  }, []);
  return <><div className="appearance sidebar-appearance"><span aria-hidden="true">{t('Appearance')}</span>
    <CommunitySelect label={t('Appearance')} hideLabel className="appearance-select" value={value} options={appearances.map(option => ({ ...option, label: t(option.label) }))} onChange={next => window.dshPhalanxAppearance?.set(next as Appearance)}/></div><div className="appearance sidebar-appearance"><span aria-hidden="true">{t('Platform language')}</span><CommunitySelect label={t('Platform language')} hideLabel className="appearance-select" value={preference} options={[{ id: 'system', label: t('System') }, { id: 'en', label: 'English' }, { id: 'zh-CN', label: '简体中文' }]} onChange={next => setPreference(next as PlatformLanguagePreference)}/></div></>;
}
const routes = [ ['accounts', 'Account management'], ['groups', 'Group management'], ['models', 'Model management'], ['settings', 'System settings'] ] as const;
export default function CommunityAdminApp() {
  const { t, errorText } = usePlatformLanguage();
  const [session, setSession] = useState<CommunityManagementSession>();
  const [error, setError] = useState<unknown>();
  const [open, setOpen] = useState(false);
  const route = location.pathname.endsWith('/groups') ? 'groups' : location.pathname.endsWith('/models') ? 'models' : location.pathname.endsWith('/settings') ? 'settings' : 'accounts';
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
      <a className="brand" href="/admin"><div className="brand-mark" aria-hidden="true"><CommunityIcon name="models" size={21}/></div><div><strong>DSH-PHALANX</strong><span>{t('Administration')}</span></div></a>
      <p className="nav-caption">{t('Administration')}</p>
      <nav className="nav-list" aria-label={t('Management')}>{routes.map(([id, title]) => <a className={`nav-item${route === id ? ' active' : ''}`} key={id} href={`/admin/${id}`} aria-current={route === id ? 'page' : undefined}><CommunityIcon name={id}/><span>{t(title)}</span></a>)}</nav>
      <div className="sidebar-bottom">
        <div className="sidebar-profile"><span className="avatar profile-avatar" aria-hidden="true">{session?.username.slice(0, 1).toUpperCase() ?? '·'}</span><div><strong>{session?.username ?? t('Loading…')}</strong><small>{t('Administrator')}</small></div><form method="post" action="/logout"><Button isIconOnly variant="tertiary" size="sm" type="submit" aria-label={t('Sign out')}><CommunityIcon name="logout" size={17}/></Button></form></div>
        <AppearanceSelect/>
        <a className="sidebar-usage-link" href="/enter" aria-label={t('Open DSH')}><span>{t('Open DSH')}</span><CommunityIcon name="arrow" size={16}/></a>
      </div>
    </aside>
    <div className="admin-workspace main-area"><header className="topbar"><nav className="breadcrumbs" aria-label={t('Breadcrumb')}><span>dsh-phalanx</span><CommunityIcon name="chevron" size={14}/><span>{t('Administration')}</span><CommunityIcon name="chevron" size={14}/><strong>{t(routes.find(([id]) => id === route)![1])}</strong></nav><span className="session-pill">{session?.username ?? '…'} · {t('Administrator')}</span></header>
    <main className="admin-content content-wrap" id="main-content">{error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error, 'Unable to load management session')}/> : <CommunityPageBoundary><Suspense fallback={<p role="status">{t('Loading management page…')}</p>}>
      {route === 'groups' ? <Groups/> : route === 'accounts' ? <Accounts session={session}/> : route === 'models' ? <><div className="page-title"><p className="eyebrow">{t('SHARED SUPPLY')}</p><h1>{t('Model management')}</h1><p>{t('Configure shared providers and the platform default model.')}</p></div><Models onConfigured={configured => setSession(viewer => viewer ? { ...viewer, modelState: configured ? 'configured' : 'unconfigured' } : viewer)}/></> : <><div className="page-title"><p className="eyebrow">{t('PLATFORM')}</p><h1>{t('System settings')}</h1><p>{t('Manage the installed version and recoverable system updates.')}</p></div><Updates/></>}
    </Suspense></CommunityPageBoundary>}</main><footer className="admin-footer app-footer"><span>dsh-phalanx</span><span>{t('A space for every teammate.')}</span></footer></div>
  </div>;
}
