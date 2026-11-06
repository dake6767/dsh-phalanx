import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import type { CommunityPluginPreview } from '../../src/domain/admin-contract'
import {
  cancelCommunityPluginPreview,
  communityPluginPreview,
  confirmCommunityPluginPreview,
  precheckCommunityPlugin,
  retryCommunityPluginPreview,
} from './community-plugin-intake-api'
import { usePlatformLanguage } from './CommunityLanguage'
import { platformError } from '../../src/domain/platform-copy'
import { pluginStageLabels, pluginVersionLabel } from './community-plugin-stage'
import CommunityDialog from './CommunityDialog'
import CommunityField from './CommunityField'
import CommunityMessage from './CommunityMessage'

export default function CommunityPluginAddDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { t, errorText, locale } = usePlatformLanguage()
  const [input, setInput] = useState(''),
    [preview, setPreview] = useState<CommunityPluginPreview>(),
    [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>()
  const pending = useRef(false),
    mounted = useRef(true),
    saving = useRef<AbortController | undefined>(undefined)
  const id = useId(),
    token = preview?.token
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      saving.current?.abort()
    }
  }, [])
  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const next = await communityPluginPreview(token, controller.signal)
        if (controller.signal.aborted) return
        setPreview(next)
        if (next.stage !== 'ready' && next.stage !== 'failed')
          timer = setTimeout(() => {
            void load()
          }, 1000)
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure)
      }
    }
    void load()
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [token, revision])
  const act = async (action: 'start' | 'retry' | 'confirm' | 'cancel' | 'reset') => {
    if (pending.current) return
    pending.current = true
    const controller = new AbortController()
    saving.current = controller
    setBusy(true)
    setError(undefined)
    try {
      if (action === 'start') setPreview(await precheckCommunityPlugin(input.trim(), controller.signal))
      else if (action === 'retry' && token) {
        setPreview(await retryCommunityPluginPreview(token, controller.signal))
        setRevision(value => value + 1)
      } else if (action === 'confirm' && token) {
        await confirmCommunityPluginPreview(token, controller.signal)
        onAdded()
      } else if (action === 'cancel' || action === 'reset') {
        if (token) {
          try {
            await cancelCommunityPluginPreview(token, controller.signal)
          } catch (failure) {
            if (!failure || typeof failure !== 'object' || !('code' in failure) || failure.code !== 'plugin-preview-unavailable') throw failure
          }
        }
        if (action === 'cancel') onClose()
        else setPreview(undefined)
      }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure)
    } finally {
      pending.current = false
      saving.current = undefined
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <CommunityDialog
      title={t('Add plugin')}
      busy={busy}
      onClose={() => {
        void act('cancel')
      }}
      footer={
        <>
          <Button
            variant="tertiary"
            isDisabled={busy}
            onPress={() => {
              void act('cancel')
            }}
          >
            {t('Cancel')}
          </Button>
          {preview ? (
            <Button
              variant="tertiary"
              isDisabled={busy}
              onPress={() => {
                void act('reset')
              }}
            >
              {t('Change input')}
            </Button>
          ) : null}
          {!preview ? (
            <Button type="submit" form={id} isDisabled={busy || !input.trim()}>
              {t('Start precheck')}
            </Button>
          ) : preview.stage === 'failed' ? (
            <Button
              isDisabled={busy}
              onPress={() => {
                void act('retry')
              }}
            >
              {t('Retry precheck')}
            </Button>
          ) : preview.stage === 'ready' ? (
            <Button
              isDisabled={busy}
              onPress={() => {
                void act('confirm')
              }}
            >
              {t('Confirm and add')}
            </Button>
          ) : null}
        </>
      }
    >
      <form
        id={id}
        className="page-stack"
        onSubmit={event => {
          event.preventDefault()
          if (!preview) void act('start')
        }}
      >
        <CommunityField label={t('Plugin identifier')} value={input} onChange={setInput} required autoFocus disabled={busy || Boolean(preview)} />
        <p>{t('Use pkg, pkg@1.2.3, pkg@latest, @scope/pkg, github:owner/repo or a GitHub repository URL.')}</p>
        {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
        {preview ? (
          <>
            <CommunityMessage role="status" status={preview.stage === 'failed' ? 'danger' : 'default'} title={t(pluginStageLabels[preview.stage])} />
            {preview.failureCode ? (
              <CommunityMessage role="alert" status="danger" title={platformError(locale, { code: preview.failureCode, error: '' })} />
            ) : null}
            {preview.version ? (
              <p>
                <strong>{t('Resolved to {version}', { version: pluginVersionLabel(preview.version, preview.sourceCommit) })}</strong>
              </p>
            ) : null}
            {preview.packageName ? (
              <p className="break-all">
                {t(preview.source === 'github' ? 'Package name' : 'npm package name')}: {preview.packageName}
              </p>
            ) : null}
            <p className="break-all">
              {t('Source')}: {preview.source === 'github' ? `GitHub ${preview.repository ?? ''}` : 'npm'}
            </p>
            {preview.sourceCommit ? (
              <p className="break-all">
                {t('Pinned commit')}: {preview.sourceCommit}
              </p>
            ) : null}
            {preview.stage === 'ready' ? (
              <section className="page-stack" aria-label={t('Plugin contents')}>
                <h3>{preview.title}</h3>
                <p>{preview.description}</p>
                <p className="break-all">
                  {t('Integrity (sha512)')}: {preview.integrity}
                </p>
                <h4>{t('Plugin dependencies')}</h4>
                {Object.keys(preview.dependencies ?? {}).length ? (
                  <ul>
                    {Object.entries(preview.dependencies ?? {}).map(([name, version]) => (
                      <li key={name} className="break-all">
                        {name}@{version}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{t('No plugin dependencies')}</p>
                )}
                <p>{t('Confirmation adds this plugin to the library without granting it to any group.')}</p>
              </section>
            ) : null}
          </>
        ) : null}
      </form>
    </CommunityDialog>
  )
}
