import { useEffect, useState } from 'react';
import { Button } from '@heroui/react/button';
import type { LibraryProvenance } from '../../src/domain/library-contribution';
import { changeCommunityLibraryMaintainer } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityField from './CommunityField';
import CommunityMessage from './CommunityMessage';

export default function CommunityLibraryMaintenance({ kind, name, provenance, revision, onChanged }: { kind: 'skill' | 'plugin'; name: string; provenance?: LibraryProvenance; revision: string; onChanged: () => void }) {
  const { t, locale, errorText } = usePlatformLanguage();
  const [username, setUsername] = useState(provenance?.maintainer?.username ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  useEffect(() => setUsername(provenance?.maintainer?.username ?? ''), [provenance?.maintainer?.username]);
  const save = async (username: string | null) => { setBusy(true); setError(undefined); try { await changeCommunityLibraryMaintainer(kind, name, { username, revision }); onChanged(); } catch (failure) { setError(failure); } finally { setBusy(false); } };
  return <section className="plugin-detail-section" aria-label={t('Maintainer')}>
    <h2>{t('Maintainer')}</h2><p>{provenance?.maintainer?.username ?? t('No maintainer')}</p>
    <p>{t('Only the maintainer can contribute updates. Administrators can replace versions or transfer ownership.')}</p>
    <CommunityField label={t('Maintainer username')} value={username} onChange={setUsername} disabled={busy}/>
    <div className="plugin-page-actions"><Button variant="secondary" isDisabled={busy || !username.trim()} onPress={() => { void save(username.trim()); }}>{t('Transfer maintainer')}</Button><Button variant="tertiary" isDisabled={busy || !provenance?.maintainer} onPress={() => { void save(null); }}>{t('Clear maintainer')}</Button></div>
    {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    <h3>{t('Version history')}</h3>
    {!provenance?.versions.length ? <p>{t('No version records')}</p> : <ul className="plugin-metadata-list">{[...provenance.versions].reverse().map((row, index) => <li key={index}><strong>{row.version}</strong><p>{row.source === 'administrator' ? t('Administrator') : row.contributor?.username} · {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(row.submittedAt)} · {t(row.source === 'administrator' ? 'Administrator replacement' : 'Member contribution')}</p></li>)}</ul>}
  </section>;
}
