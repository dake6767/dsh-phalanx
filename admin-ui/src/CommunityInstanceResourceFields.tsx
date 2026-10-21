import { Fragment } from 'react';
import type { CommunityInstanceResourceLimits } from '../../src/domain/admin-contract';
import { instanceResourceLimits } from '../../src/domain/instance-resources';
import { usePlatformLanguage, CommunityCopyError } from './CommunityLanguage';
import CommunityField from './CommunityField';

export type InstanceResourceDraft = Record<keyof CommunityInstanceResourceLimits, string>;
export function resourceDraft(value: CommunityInstanceResourceLimits): InstanceResourceDraft {
  return { cpus: value.cpus === null ? '' : String(value.cpus), memoryMiB: value.memoryMiB === null ? '' : String(value.memoryMiB), pids: value.pids === null ? '' : String(value.pids) };
}
export function draftResourceLimits(draft: InstanceResourceDraft): CommunityInstanceResourceLimits {
  const values = Object.fromEntries(Object.entries(draft).map(([key, value]) => {
    const text = value.trim();
    if (text && !(key === 'pids' ? /^\d+$/u : /^\d+(?:\.\d+)?$/u).test(text)) throw new CommunityCopyError('Enter positive resource limits or leave blank for unlimited.');
    return [key, text === '' ? null : Number(text)];
  }));
  try { return instanceResourceLimits(values); }
  catch { throw new CommunityCopyError('Enter positive resource limits or leave blank for unlimited.'); }
}
export function resourceDraftChanged(draft: InstanceResourceDraft, limits: CommunityInstanceResourceLimits): boolean {
  const saved = resourceDraft(limits);
  return (Object.keys(saved) as (keyof InstanceResourceDraft)[]).some(key => draft[key] !== saved[key]);
}
export default function CommunityInstanceResourceFields({ value, onChange, disabled }: { value: InstanceResourceDraft, onChange: (value: InstanceResourceDraft) => void, disabled: boolean }) {
  const { t } = usePlatformLanguage();
  return <div className="provider-form-fields">{([['cpus', 'CPU (cores)'], ['memoryMiB', 'Memory (MiB)'], ['pids', 'Processes']] as const).map(([key, label]) => <CommunityField key={key} label={t(label)} value={value[key]} onChange={text => onChange({ ...value, [key]: text })} disabled={disabled} pattern={key === 'pids' ? '[0-9]+' : '[0-9]+([.][0-9]+)?'} description={t('Leave blank for unlimited.')}/>)}</div>;
}
export function InstanceResourceSummary({ value }: { value: CommunityInstanceResourceLimits | null }) {
  const { t } = usePlatformLanguage();
  if (!value) return <p>{t('Current limits unavailable.')}</p>;
  return <dl className="account-details">{([['cpus', 'CPU (cores)'], ['memoryMiB', 'Memory (MiB)'], ['pids', 'Processes']] as const).map(([key, label]) => <Fragment key={key}><dt>{t(label)}</dt><dd>{value[key] === null ? t('Unlimited') : value[key]}</dd></Fragment>)}</dl>;
}
