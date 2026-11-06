import { useId, useRef, useState } from 'react'
import { platformError } from '../../src/domain/platform-copy'
import { Button } from '@heroui/react/button'
import type { CommunityPluginImpact, CommunityPluginUpdateCheck, CommunityPluginView } from '../../src/domain/admin-contract'
import { changeCommunityPlugin, checkCommunityPluginUpdate, communityPluginImpact } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityDialog from './CommunityDialog'
import CommunityField from './CommunityField'
import CommunityMessage from './CommunityMessage'
import CommunityPluginUploadDialog from './CommunityPluginUploadDialog'
import { useDraftGuard } from './useDraftGuard'

export default function CommunityPluginChanges({ plugin, onChanged }: { plugin: CommunityPluginView; onChanged: (removed?: boolean) => void }) {
  const { t, locale, errorText } = usePlatformLanguage()
  const [version, setVersion] = useState(false)
  const [upload, setUpload] = useState(false)
  const [confirmation, setConfirmation] = useState<{ action: 'select' | 'remove'; impact: CommunityPluginImpact }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const [update, setUpdate] = useState<CommunityPluginUpdateCheck>()
  const pending = useRef(false)
  const candidate = plugin.replacement
  const npm = plugin.source === 'npm'
  const github = plugin.source === 'github'
  // A GitHub row always records its commit; one without it is corrupted data and offers no update check.
  const githubCheck = github && plugin.sourceCommit !== undefined
  const run = async (work: () => Promise<void>) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      await work()
    } catch (failure) {
      setError(failure)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const checkUpdate = () =>
    run(async () => {
      setUpdate(await checkCommunityPluginUpdate(plugin.packageName))
    })
  const prepareUpdate = () =>
    run(async () => {
      await changeCommunityPlugin({ action: 'update', packageName: plugin.packageName })
      setUpdate(undefined)
      onChanged()
    })
  const preparing = candidate && candidate.stage !== 'available' && candidate.stage !== 'failed'
  const running = preparing || (plugin.stage !== 'available' && plugin.stage !== 'failed')
  const review = async (action: 'select' | 'remove') => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      setConfirmation({ action, impact: await communityPluginImpact(plugin.packageName) })
    } catch (failure) {
      setError(failure)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const apply = async () => {
    if (!confirmation || pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      await changeCommunityPlugin({ action: confirmation.action, packageName: plugin.packageName, confirmed: true, revision: confirmation.impact.revision })
      setConfirmation(undefined)
      onChanged(confirmation.action === 'remove')
    } catch (failure) {
      setConfirmation(undefined)
      setError(failure)
      onChanged()
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <>
      <section className="plugin-detail-section" aria-label={t('Version management')}>
        <h2>{t('Version management')}</h2>
        {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
        <div className="flex flex-wrap gap-2">
          {npm || githubCheck ? (
            <Button variant="secondary" isDisabled={busy || running || plugin.removing} onPress={() => void checkUpdate()}>
              {t('Check for updates')}
            </Button>
          ) : null}
          {npm ? (
            <Button variant="secondary" isDisabled={busy || running || plugin.removing} onPress={() => setVersion(true)}>
              {t('Change npm version')}
            </Button>
          ) : plugin.source === 'upload' ? (
            <Button variant="secondary" isDisabled={busy || running || plugin.removing} onPress={() => setUpload(true)}>
              {t('Upload replacement')}
            </Button>
          ) : null}
        </div>
        {update ? (
          <div role="status">
            {update.hasUpdate ? (
              <>
                <p>
                  {github
                    ? t('New commit {commit} available', { commit: (update.latestCommit ?? '').slice(0, 7) })
                    : t('New version {version} available', { version: update.latestVersion ?? '' })}
                </p>
                <Button isDisabled={busy || running || plugin.removing} onPress={() => void prepareUpdate()}>
                  {t('Precheck update')}
                </Button>
              </>
            ) : (
              <p>
                {github
                  ? t('{commit} is the latest commit', { commit: (update.latestCommit ?? '').slice(0, 7) })
                  : t('{version} is the latest npm version', { version: update.latestVersion ?? '' })}
              </p>
            )}
          </div>
        ) : null}
        <p>
          {t(
            npm
              ? 'Updates come from the npm package recorded when it was added.'
              : github
                ? 'Updates come from the GitHub repository recorded when it was added.'
                : 'Uploaded plugins are updated by uploading a replacement archive.',
          )}
        </p>
        {candidate ? (
          <div>
            <p>
              {t('Candidate version')}: {candidate.version}
            </p>
            <p role="status">{t(preparing ? 'Checking replacement…' : candidate.stage === 'available' ? 'Ready to select' : 'Precheck failed')}</p>
            {candidate.failureCode ? <CommunityMessage status="danger" title={platformError(locale, { code: candidate.failureCode, error: '' })} /> : null}
            {candidate.stage === 'available' ? (
              <Button
                isDisabled={busy || plugin.removing}
                onPress={() => {
                  void review('select')
                }}
              >
                {t('Select this version')}
              </Button>
            ) : null}
          </div>
        ) : null}
        <p>
          {t(
            plugin.incompatible
              ? 'Managed loading is paused. Select a compatible version to restore it.'
              : 'The current version stays active until you select a checked replacement.',
          )}
        </p>
      </section>
      <section className="plugin-detail-section plugin-removal" aria-label={t('Remove from library')}>
        <h2>{t('Remove from library')}</h2>
        <p>{t('Removal revokes controlled grants and shared-key selections. Installed member copies are kept.')}</p>
        {plugin.removing ? <p role="status">{t('Removal is pending. Retry to finish clearing grants.')}</p> : null}
        <Button
          variant="danger"
          isDisabled={busy || running}
          onPress={() => {
            void review('remove')
          }}
        >
          {t('Remove from library')}
        </Button>
      </section>
      {version ? (
        <VersionDialog
          packageName={plugin.packageName}
          onClose={() => setVersion(false)}
          onPrepared={() => {
            setVersion(false)
            onChanged()
          }}
        />
      ) : null}
      {upload ? (
        <CommunityPluginUploadDialog
          replacing={plugin.packageName}
          onClose={() => setUpload(false)}
          onAdded={() => {
            setUpload(false)
            onChanged()
          }}
        />
      ) : null}
      {confirmation ? (
        <CommunityDialog
          title={t(confirmation.action === 'select' ? 'Confirm version change' : 'Confirm plugin removal')}
          busy={busy}
          onClose={() => setConfirmation(undefined)}
          footer={
            <>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setConfirmation(undefined)}>
                {t('Cancel')}
              </Button>
              <Button
                variant={confirmation.action === 'remove' ? 'danger' : 'primary'}
                isPending={busy}
                onPress={() => {
                  void apply()
                }}
              >
                {t('Confirm')}
              </Button>
            </>
          }
        >
          {confirmation.action === 'remove' && confirmation.impact.experts.length ? (
            <p>{t('Will be removed from experts: {names}', { names: confirmation.impact.experts.map(row => row.name).join(', ') })}</p>
          ) : null}
          <p>{t('This affects {groups} groups and {members} members.', { groups: confirmation.impact.groups, members: confirmation.impact.members })}</p>
          <p>{t('This affects {count} members who selected this plugin.', { count: confirmation.impact.selectedMembers ?? 0 })}</p>
          {confirmation.action === 'select' ? (
            <p>
              {plugin.currentVersion ?? plugin.version} → {candidate?.version}
            </p>
          ) : null}
          <p>{t('Managed changes take effect after each member restarts their instance.')}</p>
          <p>
            {t(
              confirmation.action === 'remove'
                ? 'Removal revokes controlled grants and shared-key selections. Installed member copies are kept.'
                : 'Platform selections follow the library version after each member restarts.',
            )}
          </p>
        </CommunityDialog>
      ) : null}
    </>
  )
}

function VersionDialog({ packageName, onClose, onPrepared }: { packageName: string; onClose: () => void; onPrepared: () => void }) {
  const { t, errorText } = usePlatformLanguage()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const pending = useRef(false)
  const id = useId()
  const save = async () => {
    if (pending.current || !value.trim()) return false
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      await changeCommunityPlugin({ action: 'prepare', packageName, version: value.trim() })
      onPrepared()
      return true
    } catch (failure) {
      setError(failure)
      return false
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const guard = useDraftGuard(Boolean(value), save, () => setValue(''), busy)
  return (
    <>
      <CommunityDialog
        title={t('Change npm version')}
        busy={busy}
        onClose={() => guard.request(onClose)}
        footer={
          <>
            <Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(onClose)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" form={id} isDisabled={busy || !value.trim()}>
              {t('Start precheck')}
            </Button>
          </>
        }
      >
        {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
        <form
          id={id}
          className="page-stack"
          onSubmit={event => {
            event.preventDefault()
            void save()
          }}
        >
          <p>{packageName}</p>
          <CommunityField label={t('Exact version')} value={value} onChange={setValue} required autoFocus disabled={busy} />
        </form>
      </CommunityDialog>
      {guard.dialog}
    </>
  )
}
