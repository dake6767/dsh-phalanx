import { CommunityLanguageProvider } from './CommunityLanguage';
import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './community.css';
const CommunityAdminApp = lazy(() => import('./CommunityAdminApp'));
const CommunityMarketPage = lazy(() => import('./CommunityMarketPage'));
const market = location.pathname === '/market';
const locale = new URLSearchParams(location.search).get('locale') === 'zh-CN' ? 'zh-CN' : 'en';
createRoot(document.getElementById('root')!).render(<React.StrictMode><CommunityLanguageProvider override={market ? locale : undefined}><Suspense>{market ? <CommunityMarketPage/> : <CommunityAdminApp/>}</Suspense></CommunityLanguageProvider></React.StrictMode>);
