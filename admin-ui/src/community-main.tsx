import { CommunityLanguageProvider } from './CommunityLanguage';
import React from 'react';
import { createRoot } from 'react-dom/client';
import CommunityAdminApp from './CommunityAdminApp';
import './community.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><CommunityLanguageProvider><CommunityAdminApp/></CommunityLanguageProvider></React.StrictMode>);
