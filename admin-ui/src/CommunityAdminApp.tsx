import { lazy, Suspense, useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import type { CommunityManagementSession } from '../../src/domain/admin-contract';
import { communitySession } from './community-api';
import CommunityPageBoundary from './CommunityPageBoundary';
const Accounts = lazy(() => import('./CommunityAccountsPage'));
const Models = lazy(() => import('./CommunityModelsPanel'));
const Updates = lazy(() => import('./CommunitySystemUpdatePanel'));
const routes = [ ['accounts', 'Account management', '◫'], ['models', 'Model management', '◇'], ['settings', 'System settings', '↻'] ] as const;
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
  return <div className="admin-shell">
    <div className="mobile-bar"><a href="/admin" className="wordmark">dsh-phalanx</a><Button size="sm" variant="secondary" aria-expanded={open} aria-controls="admin-sidebar" onPress={() => setOpen(value => !value)}>{open ? 'Close navigation' : 'Open navigation'}</Button></div>
    <aside id="admin-sidebar" className={`admin-sidebar${open ? ' is-open' : ''}`}>
      <a className="wordmark" href="/admin"><span className="brand-mark">p</span>dsh-phalanx</a>
      <p className="eyebrow">ADMINISTRATION</p>
      <nav aria-label="Management">{routes.map(([id, title, icon]) => <a key={id} href={`/admin/${id}`} aria-current={route === id ? 'page' : undefined}><span aria-hidden="true">{icon}</span>{title}</a>)}</nav>
      <div className="sidebar-bottom"><label className="appearance">Appearance<select aria-label="Appearance" data-appearance defaultValue={document.documentElement.dataset.appearance ?? 'system'}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <a href="/enter" aria-label="Open DSH">Open DSH ↗</a><div className="sidebar-account"><span className="avatar" aria-hidden="true">{session?.username.slice(0, 1).toUpperCase() ?? '·'}</span><span>{session?.username ?? 'Loading…'}</span></div>
        <form method="post" action="/logout"><Button variant="tertiary" size="sm" type="submit">Sign out</Button></form>
      </div>
    </aside>
    <main className="admin-content" id="main-content">{error ? <p role="alert" className="message error">{error}</p> : <CommunityPageBoundary><Suspense fallback={<p role="status">Loading management page…</p>}>
      {route === 'accounts' ? <Accounts session={session}/> : route === 'models' ? <><div className="page-title"><p className="eyebrow">SHARED SUPPLY</p><h1>Model management</h1><p>Configure shared providers and the platform default model.</p></div><Models onConfigured={configured => setSession(viewer => viewer ? { ...viewer, modelState: configured ? 'configured' : 'unconfigured' } : viewer)}/></> : <><div className="page-title"><p className="eyebrow">PLATFORM</p><h1>System settings</h1><p>Manage the installed version and recoverable system updates.</p></div><Updates/></>}
    </Suspense></CommunityPageBoundary>}</main>
  </div>;
}
