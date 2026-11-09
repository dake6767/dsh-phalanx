import { useState, type ReactNode } from 'react'
import { Button } from '@heroui/react/button'
import { Checkbox } from '@heroui/react/checkbox'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityDialog from './CommunityDialog'

type GrantRow = {
  readonly id: string
  readonly name: string
  /** One muted line under the name, such as a package and version. */
  readonly meta?: ReactNode
  /** Extra status under the row, such as load failures. */
  readonly details?: ReactNode
  /** Inline marks next to the name. */
  readonly tags?: ReactNode
  /** Candidates that cannot be added stay listed but locked. */
  readonly locked?: boolean
}

/** Group grants list only what is granted; adding happens in a picker so long libraries do not stretch the drawer. */
export default function CommunityGrantList({
  rows,
  selected,
  onChange,
  busy,
  addLabel,
  dialogTitle,
  emptyLabel,
  noCandidatesLabel,
  revokeLabel,
  onRevoke,
  candidates,
}: {
  rows: readonly GrantRow[]
  selected: readonly string[]
  onChange: (ids: readonly string[]) => void
  busy: boolean
  addLabel: string
  dialogTitle: string
  emptyLabel: string
  noCandidatesLabel: string
  revokeLabel?: string
  /** Defaults to removing the id; plugins confirm first. */
  onRevoke?: (id: string) => void
  /** Defaults to every row that is not selected. */
  candidates?: readonly GrantRow[]
}) {
  const { t } = usePlatformLanguage()
  const [adding, setAdding] = useState(false)
  const [picking, setPicking] = useState<readonly string[]>([])
  const granted = rows.filter(row => selected.includes(row.id))
  const options = candidates ?? rows.filter(row => !selected.includes(row.id))
  return (
    <>
      {granted.length ? (
        <ul className="grant-rows">
          {granted.map(row => (
            <li key={row.id}>
              <div className="grant-row-main">
                <div className="grant-row-title">
                  <strong>{row.name}</strong>
                  {row.tags}
                </div>
                {row.meta ? <p>{row.meta}</p> : null}
                {row.details}
              </div>
              <Button
                size="sm"
                variant="tertiary"
                isDisabled={busy}
                onPress={() => (onRevoke ? onRevoke(row.id) : onChange(selected.filter(id => id !== row.id)))}
              >
                {revokeLabel ?? t('Revoke')}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="grant-rows-empty">{emptyLabel}</p>
      )}
      <div>
        <Button
          size="sm"
          variant="secondary"
          isDisabled={busy}
          onPress={() => {
            setPicking([])
            setAdding(true)
          }}
        >
          {addLabel}
        </Button>
      </div>
      {adding ? (
        <CommunityDialog
          title={dialogTitle}
          busy={busy}
          onClose={() => setAdding(false)}
          footer={
            <>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setAdding(false)}>
                {t('Cancel')}
              </Button>
              <Button
                isDisabled={busy || !picking.length}
                onPress={() => {
                  onChange([...new Set([...selected, ...picking])].sort())
                  setAdding(false)
                }}
              >
                {t('Confirm selection')}
              </Button>
            </>
          }
        >
          {options.length ? (
            <ul className="grant-picker">
              {options.map(row => (
                <li key={row.id}>
                  <Checkbox
                    isSelected={picking.includes(row.id)}
                    isDisabled={busy || row.locked}
                    onChange={checked => setPicking(current => (checked ? [...current, row.id] : current.filter(id => id !== row.id)))}
                  >
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      {row.name}
                    </Checkbox.Content>
                  </Checkbox>
                  {row.tags}
                  {row.meta ? <span className="grant-picker-meta">{row.meta}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>{noCandidatesLabel}</p>
          )}
        </CommunityDialog>
      ) : null}
    </>
  )
}
