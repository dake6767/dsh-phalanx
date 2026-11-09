import { useState } from 'react'
import { Button } from '@heroui/react/button'
import { Chip } from '@heroui/react/chip'
import { Tabs } from '@heroui/react/tabs'
import type { CommunityManagedGroupView } from '../../src/domain/admin-contract'
import { platformError } from '../../src/domain/platform-copy'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityDialog from './CommunityDialog'
import CommunityGrantList from './CommunityGrantList'
import CommunityMessage from './CommunityMessage'

export default function CommunityGroupPlugins({
  data,
  selected,
  preinstalled,
  onSelect,
  onPreinstall,
  busy,
}: {
  data: CommunityManagedGroupView | undefined
  selected: readonly string[]
  preinstalled: readonly string[]
  onSelect: (names: readonly string[]) => void
  onPreinstall: (names: readonly string[]) => void
  busy: boolean
}) {
  const { t, locale } = usePlatformLanguage()
  const [tab, setTab] = useState('preinstalled')
  const [removing, setRemoving] = useState<{ packageName: string; preinstalled: boolean }>()
  if (!data) return <p role="status">{t('Loading…')}</p>
  const list = (native: boolean) => {
    const rows = data.plugins.map(plugin => ({
      id: plugin.packageName,
      name: plugin.title,
      meta: `${plugin.packageName} · ${plugin.version ?? t('Precheck failed')}`,
      tags: !plugin.available ? (
        <Chip size="sm" variant="soft" color="danger">
          {t(plugin.incompatible ? 'Incompatible with the current version' : 'Precheck failed')}
        </Chip>
      ) : null,
      details: (
        <>
          {!native && !plugin.hasPlatformCredential ? (
            <p>{t('Read-only loading limits some plugins. If control is unnecessary, let members install this plugin from the app center.')}</p>
          ) : null}
          {!native && plugin.checking?.length ? <CommunityMessage status="default" title={t('Checking capabilities…')} /> : null}
          {!native && plugin.failures.length ? (
            <details className="plugin-member-diagnostics">
              <summary>{t('Load failed for {count} members.', { count: plugin.failures.length })}</summary>
              <ul>
                {plugin.failures.map(failure => (
                  <li key={failure.username}>
                    <strong>{failure.username}</strong> · {platformError(locale, { code: failure.code, error: '' })}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ),
    }))
    const other = native ? selected : preinstalled,
      names = native ? preinstalled : selected
    return (
      <div className="grant-tab-panel" aria-label={t(native ? 'Preinstalled plugins' : 'Platform controlled')} role="group">
        <div className="section-note">
          <p>{t(native ? 'Members can edit, disable and uninstall these native copies.' : 'Members cannot uninstall platform-controlled plugins.')}</p>
          {native ? <p>{t('Version at preinstallation; members can upgrade it themselves.')}</p> : null}
        </div>
        <CommunityGrantList
          rows={rows}
          selected={names}
          candidates={rows.filter((row, index) => data.plugins[index]!.available && !names.includes(row.id) && !other.includes(row.id))}
          onChange={native ? onPreinstall : onSelect}
          busy={busy}
          addLabel={t('Add plugins')}
          dialogTitle={t(native ? 'Add preinstalled plugins' : 'Add controlled plugins')}
          emptyLabel={t('No configured plugins')}
          noCandidatesLabel={t('No available plugins to add')}
          revokeLabel={t(native ? 'Remove from list' : 'Revoke')}
          onRevoke={packageName => setRemoving({ packageName, preinstalled: native })}
        />
      </div>
    )
  }
  return (
    <>
      {data.preinstallIncompleteMembers > 0 ? (
        <CommunityMessage status="warning" title={t('{count} members did not finish preinstallation.', { count: data.preinstallIncompleteMembers })} />
      ) : null}
      <Tabs className="grant-segment-tabs" selectedKey={tab} onSelectionChange={key => setTab(String(key))}>
        <Tabs.ListContainer>
          <Tabs.List aria-label={t('Plugin configuration')}>
            <Tabs.Tab id="preinstalled">
              {t('Preinstalled plugins')}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="controlled">
              {t('Platform controlled')}
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="preinstalled">{list(true)}</Tabs.Panel>
        <Tabs.Panel id="controlled">{list(false)}</Tabs.Panel>
      </Tabs>
      {removing ? (
        <CommunityDialog
          title={t(removing.preinstalled ? 'Remove preinstalled plugin from list' : 'Revoke controlled plugin')}
          busy={busy}
          onClose={() => setRemoving(undefined)}
          footer={
            <>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setRemoving(undefined)}>
                {t('Cancel')}
              </Button>
              <Button
                variant="danger"
                isDisabled={busy}
                onPress={() => {
                  if (removing.preinstalled) onPreinstall(preinstalled.filter(name => name !== removing.packageName))
                  else onSelect(selected.filter(name => name !== removing.packageName))
                  setRemoving(undefined)
                }}
              >
                {t('Confirm action')}
              </Button>
            </>
          }
        >
          <p>
            {t(
              removing.preinstalled
                ? 'Installed copies remain in each member’s DSH; the platform will not remove them.'
                : 'Members lose this plugin after restarting their instances.',
            )}
          </p>
        </CommunityDialog>
      ) : null}
    </>
  )
}
