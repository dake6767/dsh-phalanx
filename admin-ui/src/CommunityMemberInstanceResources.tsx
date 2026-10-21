import { Button } from '@heroui/react/button';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunitySelect from './CommunitySelect';
import CommunityMessage from './CommunityMessage';
import CommunityInstanceResourceFields, { InstanceResourceSummary } from './CommunityInstanceResourceFields';
import CommunityInstanceResourceConfirmation from './CommunityInstanceResourceConfirmation';
import type { useMemberInstanceResources } from './useMemberInstanceResources';

export default function CommunityMemberInstanceResources({ resources, disabled, onReload }: { resources: ReturnType<typeof useMemberInstanceResources>, disabled: boolean, onReload: () => void }) {
  const { t, errorText } = usePlatformLanguage(), saved = resources.saved;
  return <section className="drawer-space" aria-label={t('Instance resource limits')}><h3>{t('Instance resource limits')}</h3>
    {resources.error !== undefined && <CommunityMessage role="alert" status="danger" title={errorText(resources.error)}/>}
    {!saved ? <p role="status">{t('Loading…')}</p> : <>
      {!saved.isolated && <CommunityMessage status="warning" title={t('Limits do not apply in development mode.')}/>}
      <CommunitySelect label={t('Limit source')} value={resources.mode} onChange={value => resources.setMode(value as 'default' | 'custom')} disabled={disabled} options={[{ id: 'default', label: t('Inherit defaults') }, { id: 'custom', label: t('Custom limits') }]}/>
      {resources.mode === 'custom' && <CommunityInstanceResourceFields value={resources.draft} onChange={resources.setDraft} disabled={disabled}/>}
      <p>{t('Save changes to update the target limits. Running instances retain their current limits until applied.')}</p>
      <div className="instance-resource-comparison"><div><h4>{t('Target limits')}</h4><InstanceResourceSummary value={saved.target}/></div><div><h4>{t('Current limits')}</h4><InstanceResourceSummary value={saved.current}/></div></div>
      {saved.pending && <CommunityMessage status="warning" title={t('Limits pending')}/>}
      {saved.isolated && <Button variant="secondary" isDisabled={disabled || resources.dirty || !saved.pending || !saved.instanceKey} onPress={() => resources.setSelection(saved)}>{t('Apply immediately')}</Button>}
      <p>{t('Exceeding memory limits terminates processes inside the container. Swap is disabled when memory is limited.')}</p>
      {resources.partial && <CommunityMessage status="warning" title={t('Some instances changed or could not be updated. Review their current limits.')}/>}
    </>}
    <Button variant="tertiary" isDisabled={disabled} onPress={onReload}>{t('Reload instance limits')}</Button>
    {resources.selection && <CommunityInstanceResourceConfirmation members={[resources.selection]} busy={resources.busy} error={resources.applyError} onCancel={() => resources.setSelection(undefined)} onConfirm={() => { void resources.apply(); }}/>}</section>;
}
