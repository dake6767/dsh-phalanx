import React from 'react';
import { createRoot } from 'react-dom/client';
import CommunityAccountsPage from './CommunityAccountsPage';
import './community.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><CommunityAccountsPage/></React.StrictMode>);
