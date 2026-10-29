import { useState } from 'react'
import { Button } from '@heroui/react/button'
import { Checkbox } from '@heroui/react/checkbox'
import { Tabs } from '@heroui/react/tabs'
import type { CommunityManagedGroupView } from '../../src/domain/admin-contract'
import { platformError } from '../../src/domain/platform-copy'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityDialog from './CommunityDialog'
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
  const [tab, setTab] = useState('controlled')
  const [adding, setAdding] = useState<'controlled' | 'preinstalled'>()
  const [picking, setPicking] = useState<readonly string[]>([])
  const [removing, setRemoving] = useState<{ packageName: string; preinstalled: boolean }>()
  if (!data) return <p role="status">{t('Loading…')}</p>
  const list = (native: boolean) => {
    const names = native ? preinstalled : selected
    return (
      <section className="group-grants" aria-label={t(native ? 'Preinstalled plugins' : 'Platform controlled')}>
        <p>{t(native ? 'Members can edit, disable and uninstall these native copies.' : 'Members cannot uninstall platform-controlled plugins.')}</p>
        <ul className="group-grants-list group-plugin-list">
          {data.plugins
            .filter(plugin => names.includes(plugin.packageName))
            .map(plugin => (
              <li className="group-grant-item" key={plugin.packageName}>
                <strong>{plugin.title}</strong>
                <p>
                  {plugin.packageName} · {plugin.version ?? t('Precheck failed')}
                </p>
                {native ? (
                  <p>{t('Version at preinstallation; members can upgrade it themselves.')}</p>
                ) : !plugin.hasPlatformCredential ? (
                  <p>{t('Read-only loading limits some plugins. If control is unnecessary, let members install this plugin from the app center.')}</p>
                ) : null}
                {!plugin.available ? <p role="status">{t(plugin.incompatible ? 'Incompatible with the current version' : 'Precheck failed')}</p> : null}
                {!native && plugin.checking?.length ? <CommunityMessage status="default" title={t('Checking capabilities…')} /> : null}
                {!native
                  ? plugin.failures.map(failure => (
                      <CommunityMessage
                        key={failure.username}
                        status="danger"
                        title={`${failure.username}: ${platformError(locale, { code: failure.code, error: '' })}`}
                      />
                    ))
                  : null}
                <Button variant="tertiary" isDisabled={busy} onPress={() => setRemoving({ packageName: plugin.packageName, preinstalled: native })}>
                  {t(native ? 'Remove from list' : 'Revoke')}
                </Button>
              </li>
            ))}
        </ul>
        {!names.length ? <p>{t('No configured plugins')}</p> : null}
        <Button
          variant="secondary"
          isDisabled={busy}
          onPress={() => {
            setPicking([])
            setAdding(native ? 'preinstalled' : 'controlled')
          }}
        >
          {t('Add plugins')}
        </Button>
      </section>
    )
  }
  const candidates = data.plugins.filter(
    plugin =>
      plugin.available &&
      !(adding === 'preinstalled' ? selected : preinstalled).includes(plugin.packageName) &&
      !(adding === 'preinstalled' ? preinstalled : selected).includes(plugin.packageName),
  )
  return (
    <>
      {data.preinstallIncompleteMembers > 0 ? (
        <CommunityMessage status="warning" title={t('{count} members did not finish preinstallation.', { count: data.preinstallIncompleteMembers })} />
      ) : null}
      <Tabs variant="secondary" selectedKey={tab} onSelectionChange={key => setTab(String(key))}>
        <Tabs.ListContainer>
          <Tabs.List aria-label={t('Plugin configuration')}>
            <Tabs.Tab id="controlled">
              {t('Platform controlled')}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="preinstalled">
              {t('Preinstalled plugins')}
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="controlled">{list(false)}</Tabs.Panel>
        <Tabs.Panel id="preinstalled">{list(true)}</Tabs.Panel>
      </Tabs>
      {adding ? (
        <CommunityDialog
          title={t(adding === 'preinstalled' ? 'Add preinstalled plugins' : 'Add controlled plugins')}
          busy={busy}
          onClose={() => setAdding(undefined)}
          footer={
            <>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setAdding(undefined)}>
                {t('Cancel')}
              </Button>
              <Button
                isDisabled={busy || !picking.length}
                onPress={() => {
                  if (adding === 'preinstalled') onPreinstall([...new Set([...preinstalled, ...picking])].sort())
                  else onSelect([...new Set([...selected, ...picking])].sort())
                  setAdding(undefined)
                }}
              >
                {t('Confirm selection')}
              </Button>
            </>
          }
        >
          <div className="group-grants-list">
            {candidates.map(plugin => (
              <div className="group-grant-item" key={plugin.packageName}>
                <Checkbox
                  isSelected={picking.includes(plugin.packageName)}
                  isDisabled={busy}
                  onChange={checked =>
                    setPicking(current => (checked ? [...current, plugin.packageName] : current.filter(name => name !== plugin.packageName)))
                  }
                >
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    {plugin.title}
                  </Checkbox.Content>
                </Checkbox>
                <p>
                  {plugin.packageName} · {plugin.version}
                </p>
              </div>
            ))}
          </div>
          {!candidates.length ? <p>{t('No available plugins to add')}</p> : null}
        </CommunityDialog>
      ) : null}
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
