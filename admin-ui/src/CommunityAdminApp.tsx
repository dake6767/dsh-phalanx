import { lazy, Suspense, useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityManagementSession } from '../../src/domain/admin-contract';
import { communitySession } from './community-api';
import CommunityIcon from './CommunityIcon';
import CommunityPageBoundary from './CommunityPageBoundary';
import CommunitySelect from './CommunitySelect';
import CommunityMessage from './CommunityMessage';
const Accounts = lazy(() => import('./CommunityAccountsPage'));
const Models = lazy(() => import('./CommunityModelsPanel'));
const Updates = lazy(() => import('./CommunitySystemUpdatePanel'));
type Appearance = 'system' | 'light' | 'dark';
declare global { interface Window { dshPhalanxAppearance?: { get: () => Appearance; set: (value: Appearance) => void } } }
const appearances = [{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }] as const;
function AppearanceSelect() {
  const [value, setValue] = useState<Appearance>(() => window.dshPhalanxAppearance?.get() ?? 'system');
  useEffect(() => {
    const sync = (event: Event) => setValue((event as CustomEvent<Appearance>).detail);
    addEventListener('dsh-phalanx:appearance', sync); return () => removeEventListener('dsh-phalanx:appearance', sync);
  }, []);
  return <div className="appearance sidebar-appearance"><span aria-hidden="true">Appearance</span>
    <CommunitySelect label="Appearance" hideLabel className="appearance-select" value={value} options={appearances} onChange={next => window.dshPhalanxAppearance?.set(next as Appearance)}/></div>;
}
const routes = [ ['accounts', 'Account management'], ['models', 'Model management'], ['settings', 'System settings'] ] as const;
export default function CommunityAdminApp() {
  const [session, setSession] = useState<CommunityManagementSession>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const route = location.pathname.endsWith('/models') ? 'models' : location.pathname.endsWith('/settings') ? 'settings' : 'accounts';
  useEffect(() => {
    const legacy = location.hash === '#model-settings' ? 'models' : location.hash === '#system-update' ? 'settings' : undefined;
    if (legacy) { location.replace(`/admin/${legacy}`); return; }
    const controller = new AbortController();
    void communitySession(controller.signal).then(setSession).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load management session'); });
    return () => controller.abort();
  }, []);
  return <div className="admin-shell app-shell">
    <div className="mobile-bar"><a href="/admin" className="wordmark">dsh-phalanx</a><Button size="sm" variant="secondary" aria-expanded={open} aria-controls="admin-sidebar" onPress={() => setOpen(value => !value)}>{open ? 'Close navigation' : 'Open navigation'}</Button></div>
    <aside id="admin-sidebar" className={`admin-sidebar sidebar${open ? ' is-open' : ''}`}>
      <a className="brand" href="/admin"><div className="brand-mark" aria-hidden="true"><CommunityIcon name="models" size={21}/></div><div><strong>DSH-PHALANX</strong><span>Administration</span></div></a>
      <p className="nav-caption">Administration</p>
      <nav className="nav-list" aria-label="Management">{routes.map(([id, title]) => <a className={`nav-item${route === id ? ' active' : ''}`} key={id} href={`/admin/${id}`} aria-current={route === id ? 'page' : undefined}><CommunityIcon name={id}/><span>{title}</span></a>)}</nav>
      <div className="sidebar-bottom">
        <div className="sidebar-profile"><span className="avatar profile-avatar" aria-hidden="true">{session?.username.slice(0, 1).toUpperCase() ?? '·'}</span><div><strong>{session?.username ?? 'Loading…'}</strong><small>Administrator</small></div><form method="post" action="/logout"><Button isIconOnly variant="tertiary" size="sm" type="submit" aria-label="Sign out"><CommunityIcon name="logout" size={17}/></Button></form></div>
        <AppearanceSelect/>
        <a className="sidebar-usage-link" href="/enter" aria-label="Open DSH"><span>Open DSH</span><CommunityIcon name="arrow" size={16}/></a>
      </div>
    </aside>
    <div className="admin-workspace main-area"><header className="topbar"><nav className="breadcrumbs" aria-label="Breadcrumb"><span>dsh-phalanx</span><CommunityIcon name="chevron" size={14}/><span>Administration</span><CommunityIcon name="chevron" size={14}/><strong>{routes.find(([id]) => id === route)?.[1]}</strong></nav><span className="session-pill">{session?.username ?? '…'} · Administrator</span></header>
    <main className="admin-content content-wrap" id="main-content">{error ? <CommunityMessage role="alert" status="danger" title={error}/> : <CommunityPageBoundary><Suspense fallback={<p role="status">Loading management page…</p>}>
      {route === 'accounts' ? <Accounts session={session}/> : route === 'models' ? <><div className="page-title"><p className="eyebrow">SHARED SUPPLY</p><h1>Model management</h1><p>Configure shared providers and the platform default model.</p></div><Models onConfigured={configured => setSession(viewer => viewer ? { ...viewer, modelState: configured ? 'configured' : 'unconfigured' } : viewer)}/></> : <><div className="page-title"><p className="eyebrow">PLATFORM</p><h1>System settings</h1><p>Manage the installed version and recoverable system updates.</p></div><Updates/></>}
    </Suspense></CommunityPageBoundary>}</main><footer className="admin-footer app-footer"><span>dsh-phalanx</span><span>A space for every teammate.</span></footer></div>
  </div>;
}
