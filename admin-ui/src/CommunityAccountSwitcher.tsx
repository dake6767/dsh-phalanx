import { useEffect, useRef, useState } from 'react'
import { Modal } from '@heroui/react/modal'
import { Button } from '@heroui/react/button'
import { Avatar } from '@heroui/react/avatar'
import { Chip } from '@heroui/react/chip'
import { Dropdown } from '@heroui/react/dropdown'
import { Tooltip } from '@heroui/react/tooltip'
import { Label } from '@heroui/react/label'
import type { SignedInAccountView } from '../../src/domain/admin-contract'
import { usePlatformLanguage } from './CommunityLanguage'
import { communitySignedInAccounts, removeCommunitySignedInAccount } from './community-api'
import CommunityMessage from './CommunityMessage'
import CommunityIcon from './CommunityIcon'

function AccountRow({ account, busy, onRemove }: { account: SignedInAccountView; busy: boolean; onRemove: (marker: string) => void }) {
  const { t } = usePlatformLanguage()
  const status =
    account.status === 'current'
      ? 'Current account'
      : account.status === 'reauthentication-required'
        ? 'Sign in again'
        : account.status === 'unavailable'
          ? 'Unavailable'
          : undefined
  const meta = [account.admin ? t('Administrator') : t('Member'), ...(status && account.status !== 'current' ? [t(status)] : [])].join(' · ')
  const identity = (
    <>
      <Avatar size="sm" color={account.status === 'current' ? 'accent' : 'default'} variant="soft" aria-hidden="true">
        <Avatar.Fallback>{account.username.slice(0, 1).toUpperCase()}</Avatar.Fallback>
      </Avatar>
      <span className="account-switch-name">
        <strong>{account.username}</strong>
        <small className={account.status === 'reauthentication-required' ? 'is-warning' : undefined}>{meta}</small>
      </span>
      {account.status === 'current' ? (
        <Chip size="sm" variant="soft" color="accent">
          {t('Current account')}
        </Chip>
      ) : null}
    </>
  )
  const choose = () =>
    location.assign(account.status === 'reauthentication-required' ? `/login?username=${encodeURIComponent(account.username)}` : account.admin ? '/admin' : '/')
  return (
    <li className={`account-switch-row${account.status === 'unavailable' ? ' is-unavailable' : ''}`}>
      {account.status === 'available' ? (
        <form action="/account/switch" method="post" className="account-switch-main">
          <input type="hidden" name="marker" value={account.marker} />
          <button type="submit" className="account-switch-choice" aria-label={account.username} disabled={busy}>
            {identity}
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="account-switch-choice account-switch-main"
          aria-label={account.username}
          disabled={busy || account.status === 'unavailable'}
          onClick={choose}
        >
          {identity}
        </button>
      )}
      {account.status === 'unavailable' ? (
        <Tooltip>
          <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => onRemove(account.marker)}>
            {t('Remove')}
          </Button>
          <Tooltip.Content>{t('Remove from this browser')}</Tooltip.Content>
        </Tooltip>
      ) : (
        <Dropdown>
          <Tooltip>
            <Button size="sm" isIconOnly variant="ghost" aria-label={t('More actions')} isDisabled={busy}>
              <CommunityIcon name="more" size={16} />
            </Button>
            <Tooltip.Content>{t('Remove from this browser')}</Tooltip.Content>
          </Tooltip>
          <Dropdown.Popover>
            <Dropdown.Menu aria-label={t('More actions')} onAction={() => onRemove(account.marker)}>
              <Dropdown.Item id="remove" textValue={t('Remove')}>
                <Label title={t('Remove from this browser')}>{t('Remove')}</Label>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      )}
    </li>
  )
}

/** Management shell uses HeroUI; the DSH plugin owns its separate SDK dialog. */
export default function CommunityAccountSwitcher({ onClose }: { onClose: () => void }) {
  const { t, errorText } = usePlatformLanguage()
  const [accounts, setAccounts] = useState<readonly SignedInAccountView[]>()
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const active = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    active.current = controller
    void communitySignedInAccounts(controller.signal)
      .then(value => {
        if (!controller.signal.aborted) setAccounts(value.accounts)
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    return () => controller.abort()
  }, [])
  const remove = async (marker: string) => {
    const controller = active.current
    if (pending.current || !controller || controller.signal.aborted) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      const value = await removeCommunitySignedInAccount(marker, controller.signal)
      if (!controller.signal.aborted) setAccounts(value.accounts)
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure)
    } finally {
      pending.current = false
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return (
    <Modal>
      <Modal.Backdrop
        isOpen
        onOpenChange={open => {
          if (!open) onClose()
        }}
      >
        <Modal.Container scroll="inside" size="md">
          <Modal.Dialog aria-label={t('Switch accounts')}>
            <Modal.CloseTrigger aria-label={t('Close account switcher')} />
            <Modal.Header>
              <Modal.Heading>{t('Switch accounts')}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="account-switch-note">{t('Accounts you signed in to on this browser.')}</p>
              {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
              {accounts ? (
                <ul className="account-switch-list" aria-label={t('Switch accounts')}>
                  {accounts.map(account => (
                    <AccountRow
                      key={account.marker}
                      account={account}
                      busy={busy}
                      onRemove={marker => {
                        void remove(marker)
                      }}
                    />
                  ))}
                </ul>
              ) : error === undefined ? (
                <p role="status">{t('Loading…')}</p>
              ) : null}
            </Modal.Body>
            <Modal.Footer>
              <form action="/account/signed-in/remove-all" method="post" className="mr-auto">
                <Button type="submit" variant="ghost" isDisabled={busy}>
                  {t('Sign out of all accounts')}
                </Button>
              </form>
              <Button variant="secondary" isDisabled={busy} onPress={() => location.assign('/login?other=1')}>
                <CommunityIcon name="plus" size={16} />
                {t('Add account')}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
