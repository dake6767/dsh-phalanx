import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { Chip } from '@heroui/react/chip';
import type { CommunityMarketPack } from '../../src/domain/admin-contract';
import { marketSkillPacks, selectMarketSkillPack } from './community-api';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityMessage from './CommunityMessage';
import CommunityDialog from './CommunityDialog';
import CommunitySkillContent from './CommunitySkillContent';

export default function CommunityMarketSkillPacks({ revision, onChanged }: { revision: number; onChanged: () => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [packs, setPacks] = useState<readonly CommunityMarketPack[]>(), [error, setError] = useState<unknown>(), [busy, setBusy] = useState<string>(), [selected, setSelected] = useState<string>();
  const pending = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const value = await marketSkillPacks(controller.signal); if (!controller.signal.aborted) { setPacks(value); setError(undefined); } }
      catch (failure) { if (!controller.signal.aborted) setError(failure); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => { void load(); }, 5000); }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [revision]);
  const select = async (pack: CommunityMarketPack) => {
    if (pending.current) return;
    pending.current = true; setBusy(pack.name);
    try { await selectMarketSkillPack(pack.name, pack.source === 'selected' ? 'uninstall' : 'install'); onChanged(); }
    catch (failure) { setError(failure); } finally { pending.current = false; setBusy(undefined); }
  };
  const detail = packs?.find(pack => pack.name === selected);
  return <section className="page-stack" aria-label={t('Skill packs')}><h3>{t('Skill packs')}</h3>
    {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)}/> : null}
    {!packs ? <p role="status">{t('Loading…')}</p> : !packs.length ? <p>{t('No published skill packs')}</p> : <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{packs.map(pack => <Card key={pack.name}>
      <Card.Header><Card.Title>{pack.name}</Card.Title><Card.Description>{pack.description}</Card.Description></Card.Header>
      <Card.Content><p>{t(pack.source === 'managed' ? 'Installed (platform preinstalled)' : pack.source === 'selected' ? 'Installed (self-selected pack)' : 'Not installed')}</p><div className="flex flex-wrap gap-2">{pack.skills.map(name => <Chip size="sm" variant="soft" key={name}>{name}</Chip>)}</div></Card.Content>
      <Card.Footer><Button variant="secondary" aria-label={t('View skill pack {name}', { name: pack.name })} onPress={() => setSelected(pack.name)}>{t('Skill pack details')}</Button><Button isDisabled={busy !== undefined || pack.source === 'managed'} onPress={() => { void select(pack); }}>{t(busy === pack.name ? 'Saving…' : pack.source === 'managed' ? 'Installed' : pack.source === 'selected' ? 'Uninstall' : 'Install')}</Button></Card.Footer>
    </Card>)}</div>}
    {detail ? <CommunityDialog drawer drawerClassName="plugin-drawer" title={detail.name} eyebrow={t('Skill pack details')} closeLabel={t('Close skill pack details')} onClose={() => setSelected(undefined)}><p>{detail.description}</p><ol>{detail.skills.map(name => <li key={name}>{name}</li>)}</ol>{detail.instructions ? <CommunitySkillContent markdown={detail.instructions} files={[]}/> : null}</CommunityDialog> : null}
  </section>;
}
