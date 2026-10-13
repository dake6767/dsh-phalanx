import { CommunityLanguageProvider } from './CommunityLanguage';
import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './community.css';
const CommunityAdminApp = lazy(() => import('./CommunityAdminApp'));
createRoot(document.getElementById('root')!).render(<React.StrictMode><CommunityLanguageProvider><Suspense><CommunityAdminApp/></Suspense></CommunityLanguageProvider></React.StrictMode>);
