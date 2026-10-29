import { useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import type { CommunityInstanceResourceMember, CommunityInstanceResourceSettings } from '../../src/domain/admin-contract'
import { applyInstanceResources, instanceResourceSettings, saveInstanceResourceDefaults } from './community-api'
import CommunityField from './CommunityField'
import { usePlatformLanguage, CommunityCopyError } from './CommunityLanguage'
import { useDraftGuard } from './useDraftGuard'
import CommunityMessage from './CommunityMessage'
import CommunityInstanceResourceFields, { draftResourceLimits, resourceDraft, resourceDraftChanged } from './CommunityInstanceResourceFields'
import CommunityInstanceResourceConfirmation from './CommunityInstanceResourceConfirmation'

export default function CommunityInstanceResourceSettingsPanel() {
  const { t, errorText } = usePlatformLanguage()
  const [saved, setSaved] = useState<CommunityInstanceResourceSettings>(),
    [draft, setDraft] = useState(resourceDraft({ cpus: null, memoryMiB: null, pids: null }))
  const [idleSeconds, setIdleSeconds] = useState('1800')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [reload, setReload] = useState(0)
  const [notice, setNotice] = useState<'saved' | 'applied' | 'partial'>()
  const [selection, setSelection] = useState<{ revision: number; members: readonly CommunityInstanceResourceMember[] }>(),
    [applyError, setApplyError] = useState<unknown>()
  const submitting = useRef(false)
  const reset = (value: CommunityInstanceResourceSettings) => {
    setSaved(value)
    setIdleSeconds(String(value.idleSeconds))
    setDraft(resourceDraft(value.defaults))
  }
  useEffect(() => {
    const controller = new AbortController()
    void instanceResourceSettings(controller.signal)
      .then(value => {
        if (!controller.signal.aborted) {
          reset(value)
          setError(undefined)
        }
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    return () => controller.abort()
  }, [reload])
  const dirty = !!saved && (idleSeconds !== String(saved.idleSeconds) || resourceDraftChanged(draft, saved.defaults))
  const save = async () => {
    if (!saved || submitting.current) return false
    submitting.current = true
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      if (!/^\d+$/u.test(idleSeconds) || !Number.isSafeInteger(Number(idleSeconds)))
        throw new CommunityCopyError('Enter a non-negative whole number of idle seconds.')
      reset(
        await saveInstanceResourceDefaults({
          action: 'save-defaults',
          idleSeconds: Number(idleSeconds),
          revision: saved.revision,
          limits: draftResourceLimits(draft),
        }),
      )
      setNotice('saved')
      return true
    } catch (failure) {
      setError(failure)
      return false
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  const guard = useDraftGuard(
    dirty,
    save,
    () => {
      if (saved) reset(saved)
    },
    busy,
  )
  const apply = async () => {
    if (!selection || submitting.current) return
    submitting.current = true
    setBusy(true)
    setApplyError(undefined)
    setNotice(undefined)
    try {
      const result = await applyInstanceResources({
        action: 'apply',
        revision: selection.revision,
        confirmed: true,
        targets: selection.members.map(member => ({ username: member.username, spaceId: member.spaceId, instanceKey: member.instanceKey! })),
      })
      setSelection(undefined)
      reset(await instanceResourceSettings())
      setNotice(result.results.every(row => row.status === 'applied') ? 'applied' : 'partial')
    } catch (failure) {
      setApplyError(failure)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  const pending = saved?.pending.filter(member => member.instanceKey !== null) ?? []
  return (
    <section className="panel settings-panel" aria-label={t('Member instances')}>
      <div className="panel-top">
        <div>
          <h2>{t('Member instances')}</h2>
          <p>{t('Saved limits apply to newly started instances. Apply separately to running instances.')}</p>
        </div>
      </div>
      <div className="settings-panel-body provider-form-fields">
        {error !== undefined && <CommunityMessage role="alert" status="danger" title={errorText(error)} />}
        {!saved ? (
          <p role="status">{t('Loading…')}</p>
        ) : (
          <>
            {!saved.isolated && <CommunityMessage status="warning" title={t('Limits do not apply in development mode.')} />}
            {Object.values(saved.defaults).every(value => value === null) && (
              <CommunityMessage status="warning" title={t('Member containers have no limits.')} />
            )}
            <CommunityField
              label={t('Idle reclamation (seconds)')}
              value={idleSeconds}
              onChange={setIdleSeconds}
              disabled={busy}
              pattern="[0-9]+"
              description={t('Default: 1800 seconds. Set 0 to disable idle reclamation. Resident instances are excluded.')}
            />
            <CommunityInstanceResourceFields value={draft} onChange={setDraft} disabled={busy} />
            <p>{t('Exceeding memory limits terminates processes inside the container. Swap is disabled when memory is limited.')}</p>
            <p>
              {t('Suggested limits use half the host memory, up to 4 GiB, half its CPUs with at least one core, and 2048 processes. Adjust for your team.')}
            </p>
            <div className="instance-resource-actions">
              <Button variant="secondary" isDisabled={busy} onPress={() => setDraft(resourceDraft(saved.suggested))}>
                {t('Use suggested limits')}
              </Button>
              <Button
                isDisabled={busy || !dirty}
                onPress={() => {
                  void save()
                }}
              >
                {t('Save instance limits')}
              </Button>
            </div>
            <div>
              <h3>{t('Capacity guidance')}</h3>
              <p>{t('Host: {memory} MiB memory and {cpus} CPU cores.', { memory: Math.floor(saved.host.memoryMiB), cpus: saved.host.cpus })}</p>
              <p>
                {t('Target memory limits: running {running} MiB; resident {resident} MiB.', {
                  running: saved.capacity.runningMemoryMiB,
                  resident: saved.capacity.residentMemoryMiB,
                })}
              </p>
              <p>
                {t('Combined target memory, counting each running or resident instance once: {memory} MiB; {count} unlimited.', {
                  memory: saved.capacity.totalMemoryMiB,
                  count: saved.capacity.totalUnlimited,
                })}
              </p>
              {saved.capacity.runningUnlimited > 0 && (
                <p>{t('{count} running instances have an unlimited memory target.', { count: saved.capacity.runningUnlimited })}</p>
              )}
              {saved.capacity.overcommitted && (
                <CommunityMessage status="warning" title={t('Target memory limits exceed host memory. This warning does not block startup.')} />
              )}
            </div>
            {saved.isolated && (
              <Button
                variant="secondary"
                isDisabled={busy || dirty || !pending.length}
                onPress={() => {
                  setApplyError(undefined)
                  setSelection({ revision: saved.revision, members: pending })
                }}
              >
                {t('Apply to running instances ({count})', { count: pending.length })}
              </Button>
            )}
            {notice && (
              <CommunityMessage
                role="status"
                status={notice === 'partial' ? 'warning' : 'success'}
                title={t(
                  notice === 'saved'
                    ? 'Instance limits saved.'
                    : notice === 'applied'
                      ? 'Instance limits applied.'
                      : 'Some instances changed or could not be updated. Review their current limits.',
                )}
              />
            )}
          </>
        )}
        <div>
          <Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(() => setReload(value => value + 1))}>
            {t('Reload instance limits')}
          </Button>
        </div>
      </div>
      {guard.dialog}
      {selection && (
        <CommunityInstanceResourceConfirmation
          members={selection.members}
          busy={busy}
          error={applyError}
          onCancel={() => setSelection(undefined)}
          onConfirm={() => {
            void apply()
          }}
        />
      )}
    </section>
  )
}
