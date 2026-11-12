import { featureVisible } from '../../src/domain/release-visibility'
import { useNativeFeatures } from './useNativeFeatures'
import CommunityGroupFeatureSettings from './CommunityGroupFeatureSettings'
import type { CommunityExpertGroup } from '../../src/domain/admin-contract'
import { communityGroupExperts, saveCommunityGroupExperts } from './community-api'
import CommunityGroupMcp from './CommunityGroupMcp'
import { communityGroupMcp, saveCommunityGroupMcp } from './community-api'
import type { CommunityMcpGroup } from '../../src/domain/admin-contract'
import CommunitySkillSynchronization from './CommunitySkillSynchronization'
import { Tabs } from '@heroui/react/tabs'
import CommunityGroupSkills from './CommunityGroupSkills'
import type { CommunitySkillGroupView } from '../../src/domain/admin-contract'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import CommunityGrantList from './CommunityGrantList'
import CommunityGrantSection from './CommunityGrantSection'
import type { CommunityManagedGroupView } from '../../src/domain/admin-contract'
import { communityGroupPlugins, updateCommunityGroupPlugins, communityGroupSkills, saveCommunityGroupSkills } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import { communityGroupLabel } from './community-group-label'
import CommunityGroupPlugins from './CommunityGroupPlugins'
import CommunityDialog from './CommunityDialog'
import CommunityMessage from './CommunityMessage'
import { useDraftGuard } from './useDraftGuard'

export default function CommunityGroupDetails({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const { t, errorText } = usePlatformLanguage()
  const [mcpData, setMcpData] = useState<CommunityMcpGroup>()
  const [mcpSelected, setMcpSelected] = useState<readonly string[]>([])
  const applyMcp = (next: CommunityMcpGroup) => {
    setMcpData(next)
    setMcpSelected(
      next.services
        .filter(row => row.granted)
        .map(row => row.name)
        .sort(),
    )
  }
  const [expertData, setExpertData] = useState<CommunityExpertGroup>()
  const [expertSelected, setExpertSelected] = useState<readonly string[]>([])
  const applyExperts = (next: CommunityExpertGroup) => {
    setExpertData(next)
    setExpertSelected(
      next.experts
        .filter(row => row.granted)
        .map(row => row.id)
        .sort(),
    )
  }
  const [tab, setTab] = useState('plugins')
  const [skillData, setSkillData] = useState<CommunitySkillGroupView>()
  const [skillSelected, setSkillSelected] = useState<readonly string[]>([])
  const [packSelected, setPackSelected] = useState<readonly string[]>([])
  const [confirmSkills, setConfirmSkills] = useState(false)
  const confirmation = useRef<((saved: boolean) => void) | undefined>(undefined)
  const applySkills = (next: CommunitySkillGroupView) => {
    setSkillData(next)
    setPackSelected(
      next.packs
        ?.filter(pack => pack.granted)
        .map(pack => pack.name)
        .sort() ?? [],
    )
    setSkillSelected(
      next.skills
        .filter(skill => skill.granted)
        .map(skill => skill.name)
        .sort(),
    )
  }
  const [data, setData] = useState<CommunityManagedGroupView>()
  const [selected, setSelected] = useState<readonly string[]>([])
  const [preinstalled, setPreinstalled] = useState<readonly string[]>([])
  const [confirmPlugins, setConfirmPlugins] = useState(false)
  const [error, setError] = useState<unknown>()
  const native = useNativeFeatures(groupId, setError)
  const [saving, setBusy] = useState(false)
  const busy = saving || native.busy
  const [confirmRestart, setConfirmRestart] = useState(false)
  const pending = useRef(false)
  const apply = (next: CommunityManagedGroupView) => {
    setData(next)
    setSelected(
      next.plugins
        .filter(plugin => plugin.granted)
        .map(plugin => plugin.packageName)
        .sort(),
    )
    setPreinstalled(
      next.plugins
        .filter(plugin => plugin.preinstalled)
        .map(plugin => plugin.packageName)
        .sort(),
    )
  }
  useEffect(() => {
    const controller = new AbortController()
    void communityGroupPlugins(groupId, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) apply(value)
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    void communityGroupExperts(groupId, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) applyExperts(value)
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    void communityGroupMcp(groupId, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) applyMcp(value)
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    void communityGroupSkills(groupId, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) applySkills(value)
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    return () => {
      controller.abort()
      confirmation.current?.(false)
    }
  }, [groupId])
  useEffect(() => {
    if (!data?.plugins.some(plugin => plugin.checking?.length) || busy) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void communityGroupPlugins(groupId, controller.signal)
        .then(next => {
          if (!controller.signal.aborted)
            setData(previous =>
              previous
                ? {
                    ...previous,
                    plugins: previous.plugins.map(plugin => {
                      const current = next.plugins.find(row => row.packageName === plugin.packageName)
                      return current ? { ...plugin, checking: current.checking, failures: current.failures } : plugin
                    }),
                  }
                : previous,
            )
        })
        .catch(failure => {
          if (!controller.signal.aborted) setError(failure)
        })
    }, 1000)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [data, groupId, busy])
  const pluginDirty =
    data !== undefined &&
    (JSON.stringify([...selected].sort()) !==
      JSON.stringify(
        data.plugins
          .filter(plugin => plugin.granted)
          .map(plugin => plugin.packageName)
          .sort(),
      ) ||
      JSON.stringify([...preinstalled].sort()) !==
        JSON.stringify(
          data.plugins
            .filter(plugin => plugin.preinstalled)
            .map(plugin => plugin.packageName)
            .sort(),
        ))
  const execute = async (restart: boolean) => {
    if (!data || pending.current) return false
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      apply(
        await updateCommunityGroupPlugins(
          groupId,
          restart ? { action: 'restart', confirmed: true } : { action: 'save', packages: selected, preinstalls: preinstalled, revision: data.revision },
        ),
      )
      setConfirmRestart(false)
      return true
    } catch (failure) {
      setError(failure)
      return false
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const packDirty =
    skillData !== undefined &&
    JSON.stringify([...packSelected].sort()) !==
      JSON.stringify(
        skillData.packs
          ?.filter(pack => pack.granted)
          .map(pack => pack.name)
          .sort() ?? [],
      )
  const skillDirty =
    packDirty ||
    (skillData !== undefined &&
      JSON.stringify([...skillSelected].sort()) !==
        JSON.stringify(
          skillData.skills
            .filter(skill => skill.granted)
            .map(skill => skill.name)
            .sort(),
        ))
  const mcpDirty =
    mcpData !== undefined &&
    JSON.stringify([...mcpSelected].sort()) !==
      JSON.stringify(
        mcpData.services
          .filter(row => row.granted)
          .map(row => row.name)
          .sort(),
      )
  const executeMcp = async () => {
    if (pending.current) return false
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      applyMcp(await saveCommunityGroupMcp(groupId, mcpSelected))
      return true
    } catch (failure) {
      setError(failure)
      return false
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const expertDirty =
    expertData !== undefined &&
    JSON.stringify([...expertSelected].sort()) !==
      JSON.stringify(
        expertData.experts
          .filter(row => row.granted)
          .map(row => row.id)
          .sort(),
      )
  const executeExperts = async () => {
    if (!expertData || pending.current) return false
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      applyExperts(await saveCommunityGroupExperts(groupId, expertSelected, expertData.revision))
      return true
    } catch (failure) {
      setError(failure)
      return false
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const dirty =
    tab === 'native-features' ? native.dirty : tab === 'experts' ? expertDirty : tab === 'mcp' ? mcpDirty : tab === 'skills' ? skillDirty : pluginDirty
  const requestSkillSave = () =>
    new Promise<boolean>(resolve => {
      if (confirmation.current || !skillData) {
        resolve(false)
        return
      }
      confirmation.current = resolve
      setConfirmSkills(true)
    })
  const finishSkillConfirmation = (saved: boolean) => {
    setConfirmSkills(false)
    confirmation.current?.(saved)
    confirmation.current = undefined
  }
  const executeSkills = async () => {
    if (!skillData || pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      applySkills(await saveCommunityGroupSkills(groupId, skillSelected, skillData.revision, packSelected))
      finishSkillConfirmation(true)
    } catch (failure) {
      setError(failure)
      finishSkillConfirmation(false)
      try {
        applySkills(await communityGroupSkills(groupId))
      } catch {
        /* Keep the original mutation failure visible. */
      }
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const movedToPreinstall = data?.plugins.some(plugin => plugin.granted && preinstalled.includes(plugin.packageName))
  const movedToControlled = data?.plugins.some(plugin => plugin.preinstalled && selected.includes(plugin.packageName))
  const requestPluginSave = () => {
    if (!movedToPreinstall && !movedToControlled) return execute(false)
    return new Promise<boolean>(resolve => {
      if (confirmation.current) {
        resolve(false)
        return
      }
      confirmation.current = resolve
      setConfirmPlugins(true)
    })
  }
  const finishPluginConfirmation = (saved: boolean) => {
    setConfirmPlugins(false)
    confirmation.current?.(saved)
    confirmation.current = undefined
  }
  const save = () =>
    tab === 'native-features'
      ? native.save()
      : tab === 'experts'
        ? executeExperts()
        : tab === 'mcp'
          ? executeMcp()
          : tab === 'skills'
            ? requestSkillSave()
            : requestPluginSave()
  const guard = useDraftGuard(
    dirty,
    save,
    () => {
      native.discard()
      if (data) apply(data)
      if (skillData) applySkills(skillData)
      if (mcpData) applyMcp(mcpData)
      if (expertData) applyExperts(expertData)
    },
    busy,
  )
  return (
    <>
      <CommunityDialog
        drawer
        drawerClassName="plugin-drawer library-form-drawer group-drawer"
        title={data ? communityGroupLabel(data.group, t) : t('Group details')}
        closeLabel={t('Close group details')}
        busy={busy}
        onClose={() => guard.request(onClose)}
        footer={
          <>
            <Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(onClose)}>
              {t('Close group details')}
            </Button>
            {data ? (
              <Button
                isDisabled={busy || !dirty}
                onPress={() => {
                  void save()
                }}
              >
                {busy ? t('Saving…') : t('Save changes')}
              </Button>
            ) : null}
          </>
        }
      >
        <CommunitySkillSynchronization />
        {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
        <Tabs className="plugin-detail-tabs" variant="secondary" selectedKey={tab} onSelectionChange={key => guard.request(() => setTab(String(key)))}>
          <Tabs.ListContainer>
            <Tabs.List aria-label={t('Group details')}>
              <Tabs.Tab id="plugins">
                {t('Plugins')}
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="skills">
                {t('Skills')}
                <Tabs.Indicator />
              </Tabs.Tab>
              {featureVisible('experts') ? (
                <Tabs.Tab id="experts">
                  {t('Expert grants')}
                  <Tabs.Indicator />
                </Tabs.Tab>
              ) : null}
              <Tabs.Tab id="mcp">
                {t('MCP grants')}
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="native-features">
                {t('Feature settings')}
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
          <Tabs.Panel id="plugins" className="plugin-settings-panel">
            {data ? (
              <CommunityGrantSection
                title={t('Plugin configuration')}
                description={
                  <>
                    <p>{t('Controlled plugins cannot be uninstalled; preinstalled copies belong to members.')}</p>
                    {data.group.kind === 'admin' ? <p>{t('Administrator instances only receive explicitly configured plugins.')}</p> : null}
                  </>
                }
              >
                {data.pendingMembers.length ? (
                  <div className="grant-pending">
                    <CommunityMessage
                      role="status"
                      status="accent"
                      title={t('{count} running members have pending changes.', { count: data.pendingMembers.length })}
                    />
                    <Button size="sm" variant="secondary" isDisabled={busy || dirty} onPress={() => setConfirmRestart(true)}>
                      {t('Restart affected members')}
                    </Button>
                  </div>
                ) : null}
                <CommunityGroupPlugins
                  data={data}
                  selected={selected}
                  preinstalled={preinstalled}
                  onSelect={setSelected}
                  onPreinstall={setPreinstalled}
                  busy={busy}
                />
              </CommunityGrantSection>
            ) : (
              <p role="status">{t('Loading…')}</p>
            )}
          </Tabs.Panel>
          <Tabs.Panel id="skills" className="plugin-settings-panel">
            <CommunityGrantSection
              title={t('Skill grants')}
              description={
                <>
                  <p>{t('Skill grant changes apply to new sessions without restarting instances.')}</p>
                  {skillData?.group.kind === 'admin' ? <p>{t('Administrator instances only receive explicitly configured skills and skill packs.')}</p> : null}
                </>
              }
            >
              <CommunityGroupSkills
                data={skillData}
                selected={skillSelected}
                onSelect={setSkillSelected}
                busy={busy}
                packs={packSelected}
                onPacks={setPackSelected}
              />
            </CommunityGrantSection>
          </Tabs.Panel>
          {featureVisible('experts') ? (
            <Tabs.Panel id="experts" className="plugin-settings-panel">
              <CommunityGrantSection
                title={t('Expert grants')}
                description={
                  <>
                    <p>{t('Expert changes take effect after members restart their instances.')}</p>
                    {expertData?.group.kind === 'admin' ? <p>{t('Administrator instances only receive explicitly configured experts.')}</p> : null}
                  </>
                }
              >
                <CommunityMessage
                  status="warning"
                  title={t('Members granted this expert can use all its entries and platform credentials, including entries not granted separately.')}
                />
                {expertData ? (
                  <CommunityGrantList
                    rows={expertData.experts.map(expert => ({ id: expert.id, name: expert.name }))}
                    selected={expertSelected}
                    onChange={setExpertSelected}
                    busy={busy}
                    addLabel={t('Add experts')}
                    dialogTitle={t('Add experts')}
                    emptyLabel={t('No granted experts')}
                    noCandidatesLabel={t('No experts available to add')}
                  />
                ) : (
                  <p role="status">{t('Loading…')}</p>
                )}
              </CommunityGrantSection>
            </Tabs.Panel>
          ) : null}
          <Tabs.Panel id="mcp" className="plugin-settings-panel">
            <CommunityGrantSection
              title={t('MCP grants')}
              description={
                <>
                  <p>{t('MCP changes take effect immediately. Tools update on the next agent request.')}</p>
                  <p>{t('Administrator instances also require explicit group configuration.')}</p>
                </>
              }
            >
              <CommunityGroupMcp data={mcpData} selected={mcpSelected} onSelect={setMcpSelected} busy={busy} />
            </CommunityGrantSection>
          </Tabs.Panel>
          <Tabs.Panel id="native-features" className="plugin-settings-panel">
            <CommunityGroupFeatureSettings settings={native} busy={busy} />
          </Tabs.Panel>
        </Tabs>
      </CommunityDialog>
      {confirmRestart ? (
        <CommunityDialog
          title={t('Restart affected members')}
          busy={busy}
          onClose={() => setConfirmRestart(false)}
          footer={
            <>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setConfirmRestart(false)}>
                {t('Cancel')}
              </Button>
              <Button
                variant="danger"
                isDisabled={busy}
                onPress={() => {
                  void execute(true)
                }}
              >
                {t('Confirm action')}
              </Button>
            </>
          }
        >
          <p>{t('Running tasks for affected members will be interrupted. Stopped instances will not be started.')}</p>
        </CommunityDialog>
      ) : null}
      {confirmSkills && skillData ? (
        <CommunityDialog
          title={t('Confirm skill grants')}
          busy={busy}
          onClose={() => finishSkillConfirmation(false)}
          footer={
            <>
              <Button variant="tertiary" isDisabled={busy} onPress={() => finishSkillConfirmation(false)}>
                {t('Cancel')}
              </Button>
              <Button
                isDisabled={busy}
                onPress={() => {
                  void executeSkills()
                }}
              >
                {t('Confirm action')}
              </Button>
            </>
          }
        >
          <p>{t('{count} affected members', { count: skillData.members })}</p>
          <CommunityMessage status="warning" title={t('Changes apply to new sessions. Running tasks using this skill may fail.')} />
        </CommunityDialog>
      ) : null}
      {confirmPlugins ? (
        <CommunityDialog
          title={t('Confirm plugin configuration change')}
          busy={busy}
          onClose={() => finishPluginConfirmation(false)}
          footer={
            <>
              <Button variant="tertiary" isDisabled={busy} onPress={() => finishPluginConfirmation(false)}>
                {t('Cancel')}
              </Button>
              <Button
                isDisabled={busy}
                onPress={() => {
                  void execute(false).then(finishPluginConfirmation)
                }}
              >
                {t('Confirm action')}
              </Button>
            </>
          }
        >
          {movedToPreinstall ? (
            <p>
              {t(
                'Preinstalled native copies have editable settings but do not use platform credentials. Existing selected or expert read-only plugins still take priority.',
              )}
            </p>
          ) : null}
          {movedToControlled ? <p>{t('Moving to platform control discards members’ setting changes after restart.')}</p> : null}
        </CommunityDialog>
      ) : null}
      {guard.dialog}
    </>
  )
}
