import { upstreamWriteInput } from '../../src/domain/plugin-upstream'
import { Checkbox } from '@heroui/react/checkbox'
import CommunityContributionDependencies from './CommunityContributionDependencies'
import CommunityContributionChanges from './CommunityContributionChanges'
import CommunityContributionPluginConfiguration from './CommunityContributionPluginConfiguration'
import { contributionsChanged } from './useContributionCount'
import { Card } from '@heroui/react/card'
import { Button } from '@heroui/react/button'
import { Chip } from '@heroui/react/chip'
import { Switch } from '@heroui/react/switch'
import { Label } from '@heroui/react/label'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ContributionPluginDraft, CommunityContributionsView } from '../../src/domain/admin-contract'
import {
  inspectCommunityContribution,
  reviewCommunityContribution,
  communityContributions,
  decideCommunityContribution,
  testCommunityContribution,
} from './community-api'
import CommunityContributionDistribution from './CommunityContributionDistribution'
import CommunityExecutionFields, { executionDraft, executionInput } from './CommunityExecutionFields'
import CommunitySkillExecution from './CommunitySkillExecution'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityDialog from './CommunityDialog'
import CommunityMessage from './CommunityMessage'
import CommunityField from './CommunityField'
import CommunitySkillContent from './CommunitySkillContent'

export default function CommunityContributions({ onChanged, kind = 'skill' }: { onChanged: () => void; kind?: 'skill' | 'plugin' }) {
  const { t, locale, errorText } = usePlatformLanguage()
  const [data, setData] = useState<CommunityContributionsView>(),
    [error, setError] = useState<unknown>()
  const [selected, setSelected] = useState<string>(),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0)
  const [step, setStep] = useState<'review' | 'configuration' | 'distribution' | 'complete'>('review')
  const [review, setReview] = useState<Awaited<ReturnType<typeof reviewCommunityContribution>>>()
  const [inspection, setInspection] = useState<Awaited<ReturnType<typeof inspectCommunityContribution>>>()
  const [assignMaintainer, setAssignMaintainer] = useState(false),
    [anonymous, setAnonymous] = useState(false)
  const [pluginDraft, setPluginDraft] = useState<ContributionPluginDraft>()
  const [draft, setDraft] = useState<ReturnType<typeof executionDraft>>({ commandRows: [], variableRows: [] })
  const [enabled, setEnabled] = useState(false),
    [dependencyNames, setDependencyNames] = useState<readonly string[]>([]),
    [published, setPublished] = useState(false),
    [groups, setGroups] = useState<readonly string[]>([])
  const [dependenciesReady, setDependenciesReady] = useState(false)
  const [sharingConfirmed, setSharingConfirmed] = useState(false)
  const sharing = kind === 'plugin' && !!pluginDraft?.upstreams.some(row => row.hasCredential || !!row.credential)
  const [discarding, setDiscarding] = useState(false)
  const guard = useRef<((action: () => void) => void) | undefined>(undefined)
  const onGuard = useCallback((value: ((action: () => void) => void) | undefined) => {
    guard.current = value
  }, [])
  const detail = data?.contributions.find(row => row.id === selected)
  useEffect(() => {
    const controller = new AbortController()
    setInspection(undefined)
    if (detail)
      void inspectCommunityContribution(detail.id, detail.revision, controller.signal)
        .then(value => {
          if (!controller.signal.aborted) setInspection(value)
        })
        .catch(failure => {
          if (!controller.signal.aborted) setError(failure)
        })
    return () => controller.abort()
  }, [detail?.id, detail?.revision, detail?.status])
  const refresh = () => setRevision(value => value + 1)
  useEffect(() => {
    const controller = new AbortController()
    void communityContributions(controller.signal)
      .then(value => {
        if (!controller.signal.aborted) {
          setData({ contributions: value.contributions.filter(row => (row.kind ?? 'skill') === kind) })
          setError(undefined)
        }
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    return () => controller.abort()
  }, [revision, kind])
  const close = () => {
    if (step === 'complete' && guard.current) guard.current(() => setSelected(undefined))
    else if (step === 'configuration' || step === 'distribution') setDiscarding(true)
    else {
      setSelected(undefined)
      setPluginDraft(undefined)
      setDraft({ commandRows: [], variableRows: [] })
    }
  }
  const startAdoption = async () => {
    if (!detail || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const value = await reviewCommunityContribution(detail.id, detail.revision)
      setAssignMaintainer(false)
      setAnonymous(value.maintenance?.anonymous ?? false)
      setReview(value)
      setDraft(executionDraft(value.execution ?? { enabled: false, commands: [], variables: [] }))
      setEnabled(value.execution?.enabled ?? false)
      setDependencyNames(value.dependencies?.references ?? [])
      setDependenciesReady(false)
      setGroups([])
      setPublished(false)
      setSharingConfirmed(false)
      setPluginDraft(
        value.plugin
          ? {
              access: value.plugin.access,
              upstreams: value.plugin.upstreams.map(row => ({
                ...upstreamWriteInput(
                  row,
                  detail.declaration.plugin?.upstreams.find(item => item.name === row.name),
                ),
                hasCredential: row.credential.configured,
              })),
            }
          : undefined,
      )
      setStep('configuration')
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  const decide = async (action: 'adopt' | 'decline') => {
    if (!detail || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await decideCommunityContribution(
        detail.id,
        action,
        reason,
        detail.revision,
        review?.token,
        action === 'adopt' && kind === 'skill'
          ? {
              maintenance: { anonymous, ...(review?.maintenance?.canAssignMaintainer ? { assignMaintainer } : {}) },
              runtimeDependencies: dependencyNames,
              execution: {
                enabled,
                ...executionInput(draft),
                runtimeDependencies: [...new Set([...(review?.execution?.runtimeDependencies ?? []), ...dependencyNames])],
              },
              ...(published ? { published: true } : {}),
              groups: groups.map(id => ({ id, revision: review!.groups!.find(group => group.group.id === id)!.revision })),
            }
          : action === 'adopt' && kind === 'plugin'
            ? {
                maintenance: { anonymous, ...(review?.maintenance?.canAssignMaintainer ? { assignMaintainer } : {}) },
                ...(pluginDraft ? { plugin: pluginDraft } : {}),
                ...(published ? { published: true, credentialSharingConfirmed: sharingConfirmed } : {}),
                groups: groups.map(id => ({ id, revision: review!.groups!.find(group => group.group.id === id)!.revision })),
              }
            : undefined,
      )
      if (action === 'adopt') {
        setStep('complete')
        setDraft({ commandRows: [], variableRows: [] })
        setPluginDraft(undefined)
      } else setSelected(undefined)
      refresh()
      onChanged()
      window.dispatchEvent(new Event(contributionsChanged))
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  const status = (value: string) =>
    t(value === 'pending' ? 'Pending contribution' : value === 'adopted' ? 'Adopted' : value === 'declined' ? 'Not adopted' : 'Withdrawn')
  const date = (value: number) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
  return (
    <section className="panel plugin-library-panel" aria-label={t('Member contributions')}>
      <div className="panel-top panel-filter-header">
        <div>
          <div className="panel-title-row">
            <h2>{t('Member contributions')}</h2>
            <span className="panel-item-count">{data?.contributions.filter(row => row.status === 'pending').length ?? '—'}</span>
          </div>
          <p>{t('Review contributions before adding them to the library.')}</p>
        </div>
        <Button variant="secondary" onPress={refresh}>
          {t('Reload')}
        </Button>
      </div>
      {error !== undefined && !detail ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
      {!data ? (
        <p role="status">{t('Loading…')}</p>
      ) : !data.contributions.length ? (
        <p className="empty-state">{t('No contributions yet')}</p>
      ) : (
        <div className="plugin-card-grid">
          {data.contributions.map(row => (
            <Card key={row.id} className="plugin-library-card">
              <Card.Header>
                <div className="plugin-card-top">
                  <Chip size="sm" variant="soft">
                    {status(row.status)}
                  </Chip>
                </div>
                <Card.Title>{row.name}</Card.Title>
                <Card.Description>{row.declaration.purpose}</Card.Description>
              </Card.Header>
              <Card.Content>
                <p>
                  {row.contributor.username} · {date(row.submittedAt)}
                </p>
              </Card.Content>
              <Card.Footer>
                <Button
                  variant="secondary"
                  onPress={() => {
                    setReview(undefined)
                    setStep('review')
                    setReason('')
                    setError(undefined)
                    setSelected(row.id)
                  }}
                >
                  {t('Review contribution')}
                </Button>
              </Card.Footer>
            </Card>
          ))}
        </div>
      )}
      {detail ? (
        <CommunityDialog
          drawer
          drawerClassName="plugin-drawer"
          eyebrow={t('Member contributions')}
          title={detail.name}
          busy={busy}
          onClose={close}
          footer={
            step === 'configuration' ? (
              <>
                <Button variant="secondary" isDisabled={busy} onPress={() => setStep('review')}>
                  {t('Back to review')}
                </Button>
                <Button isDisabled={busy || (kind === 'skill' && !dependenciesReady)} onPress={() => setStep('distribution')}>
                  {t('Continue to distribution')}
                </Button>
              </>
            ) : step === 'distribution' ? (
              <>
                <Button variant="secondary" isDisabled={busy} onPress={() => setStep('configuration')}>
                  {t('Back to configuration')}
                </Button>
                <Button
                  isDisabled={busy || (kind === 'skill' && !dependenciesReady) || (published && sharing && !sharingConfirmed)}
                  onPress={() => {
                    void decide('adopt')
                  }}
                >
                  {t('Confirm adoption')}
                </Button>
              </>
            ) : step === 'complete' ? (
              <Button onPress={close}>{t('Finish adoption')}</Button>
            ) : detail.status === 'pending' ? (
              <>
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => {
                    void decide('decline')
                  }}
                >
                  {t('Do not adopt')}
                </Button>
                <Button
                  isDisabled={busy}
                  onPress={() => {
                    void startAdoption()
                  }}
                >
                  {t('Adopt contribution')}
                </Button>
              </>
            ) : undefined
          }
        >
          {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
          <div className="plugin-card-top">
            {(['review', 'configuration', 'distribution'] as const).map((value, index) => (
              <Chip key={value} size="sm" variant="soft" color={step === value ? 'accent' : 'default'}>
                {index + 1} · {t(value === 'review' ? 'Review' : value === 'configuration' ? 'Configuration' : 'Distribution')}
              </Chip>
            ))}
          </div>
          {review && step !== 'review' && step !== 'complete' ? (
            <CommunityMessage
              status="warning"
              title={t(
                review.replacing
                  ? kind === 'plugin'
                    ? 'This replaces the current plugin and retains its publication and grants.'
                    : 'This replaces the current skill and retains its publication and grants.'
                  : 'Adoption adds a platform copy without publishing or granting it.',
              )}
            >
              {t('{managed} managed members · {selected} member selections', { managed: review.managedMembers, selected: review.selectedMembers })}
            </CommunityMessage>
          ) : null}
          {step === 'configuration' && kind === 'plugin' && pluginDraft ? (
            <CommunityContributionPluginConfiguration
              draft={pluginDraft}
              onChange={setPluginDraft}
              declaration={detail.declaration.plugin}
              removed={review!.plugin!.removed}
              accessStatus={review!.plugin!.accessStatus}
              upstreamStatus={review!.plugin!.upstreams}
              busy={busy}
              onTest={upstream => testCommunityContribution(detail.id, detail.revision, review!.token, upstream)}
            />
          ) : step === 'configuration' && kind === 'skill' ? (
            <section className="plugin-detail-section">
              <CommunityContributionDependencies
                declaration={review?.dependencies}
                value={dependencyNames}
                onChange={setDependencyNames}
                onReady={setDependenciesReady}
                busy={busy}
              />
              <p>{t('Declared execution commands and variables are prefilled. Enter platform credentials for delegated execution.')}</p>
              <Switch isSelected={enabled} onChange={setEnabled} isDisabled={busy}>
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Label>{t('Enable platform execution')}</Label>
                </Switch.Content>
              </Switch>
              <CommunityExecutionFields draft={draft} onChange={setDraft} busy={busy} />
              {review?.executionRemoved && [...review.executionRemoved.commands, ...review.executionRemoved.variables].length ? (
                <p>
                  {t('Removed execution items')}: {[...review.executionRemoved.commands, ...review.executionRemoved.variables].join(', ')} ·{' '}
                  {t('Items removed from the declaration are retained until you choose to clear them.')}
                </p>
              ) : null}
              {detail.declaration.execution?.variables.map(variable => (
                <p key={variable.name}>
                  <strong>{variable.name}</strong> · {variable.purpose} · {variable.application}
                </p>
              ))}
            </section>
          ) : step === 'distribution' ? (
            <>
              <section className="plugin-detail-section">
                {review?.maintenance?.canAssignMaintainer ? (
                  <Checkbox isSelected={assignMaintainer} onChange={setAssignMaintainer} isDisabled={busy}>
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      {t('Assign contributor as maintainer')}
                    </Checkbox.Content>
                  </Checkbox>
                ) : null}
                <Checkbox isSelected={anonymous} onChange={setAnonymous} isDisabled={busy}>
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    {t('Show contribution anonymously')}
                  </Checkbox.Content>
                </Checkbox>
              </section>
              <CommunityContributionDistribution
                name={detail.name}
                groups={review?.groups ?? []}
                selected={groups}
                onSelected={setGroups}
                published={published}
                onPublished={setPublished}
                busy={busy}
                sharing={sharing}
                confirmed={sharingConfirmed}
                onConfirmed={setSharingConfirmed}
              />
            </>
          ) : step === 'complete' ? (
            <>
              <CommunityMessage status="success" title={t('Adopted')} />
              {detail.reason ? <CommunityMessage status="warning" title={detail.reason} /> : null}
              {kind === 'skill' ? <CommunitySkillExecution name={detail.name} onCloseGuard={onGuard} /> : null}
            </>
          ) : (
            <>
              <CommunityContributionChanges review={inspection?.maintenance ?? review?.maintenance} />
              <p className="drawer-description">{detail.declaration.purpose}</p>
              <p>
                {detail.contributor.username} · {date(detail.submittedAt)} · {status(detail.status)}
              </p>
              {detail.findings?.map((finding, index) => (
                <CommunityMessage key={index} status="warning" title={finding.code}>
                  <p>{finding.path}</p>
                  <p>{finding.advice}</p>
                  <p>{t(detail.retainedWarnings ? 'The member chose to retain these warnings.' : 'Review this finding.')}</p>
                </CommunityMessage>
              ))}
              {kind === 'skill' ? (
                <CommunitySkillContent markdown={detail.markdown} files={detail.files} />
              ) : (
                <section className="plugin-detail-section">
                  <h3>{t('Package files')}</h3>
                  <ul>
                    {detail.files.map(path => (
                      <li key={path}>
                        <code>{path}</code>
                      </li>
                    ))}
                  </ul>
                  {detail.keyFiles?.map(file => (
                    <section className="plugin-detail-section" key={file.path}>
                      <h3>{file.path}</h3>
                      <pre className="plugin-raw-config">{file.content}</pre>
                    </section>
                  ))}
                </section>
              )}
              {detail.reason ? <p>{detail.reason}</p> : null}
              {detail.status === 'pending' ? <CommunityField label={t('Reason for not adopting (optional)')} value={reason} onChange={setReason} /> : null}
            </>
          )}
        </CommunityDialog>
      ) : null}
      {discarding ? (
        <CommunityDialog
          title={t('Discard contribution configuration?')}
          onClose={() => setDiscarding(false)}
          footer={
            <>
              <Button variant="secondary" onPress={() => setDiscarding(false)}>
                {t('Continue editing')}
              </Button>
              <Button
                variant="danger"
                onPress={() => {
                  setDiscarding(false)
                  setSelected(undefined)
                  setDraft({ commandRows: [], variableRows: [] })
                  setPluginDraft(undefined)
                }}
              >
                {t('Discard changes')}
              </Button>
            </>
          }
        >
          <p>{t('This contribution has not been adopted. Closing discards the configuration you entered.')}</p>
        </CommunityDialog>
      ) : null}
    </section>
  )
}
