import { useEffect, useState } from 'react'
import { CheckboxGroup } from '@heroui/react/checkbox-group'
import { Checkbox } from '@heroui/react/checkbox'
import { Label } from '@heroui/react/label'
import type { CommunityRuntimeDependencyView } from '../../src/domain/admin-contract'
import { communityRuntimeDependencies } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityMessage from './CommunityMessage'
import { Button } from '@heroui/react/button'

/** Resource forms share this selection control; each resource retains its own save transaction. */
export default function CommunityDependencyPicker({
  value,
  onChange,
  disabled = false,
  items,
  hideLabel = false,
  readOnly = false,
}: {
  value: readonly string[]
  onChange: (names: string[]) => void
  disabled?: boolean
  items?: readonly CommunityRuntimeDependencyView[]
  hideLabel?: boolean
  /** Lock the selection and hide the management link, for platform-maintained resources. */
  readOnly?: boolean
}) {
  const { t, errorText } = usePlatformLanguage()
  const [loaded, setRows] = useState<readonly CommunityRuntimeDependencyView[]>(),
    [error, setError] = useState<unknown>(),
    [revision, setRevision] = useState(0)
  const rows = items ?? loaded
  useEffect(() => {
    if (items) return
    const controller = new AbortController()
    void communityRuntimeDependencies(controller.signal)
      .then(items => {
        if (!controller.signal.aborted) {
          setRows(items)
          setError(undefined)
        }
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure)
      })
    return () => controller.abort()
  }, [revision, items])
  return (
    <div className="page-stack dependency-picker-stack">
      {error !== undefined ? (
        <>
          <CommunityMessage role="alert" status="danger" title={errorText(error)} />
          <Button variant="secondary" onPress={() => setRevision(number => number + 1)}>
            {t('Reload dependencies')}
          </Button>
        </>
      ) : null}
      {rows === undefined ? (
        <p role="status">{t('Loading…')}</p>
      ) : (
        <CheckboxGroup className="dependency-picker" value={[...value]} onChange={onChange} isDisabled={disabled || readOnly}>
          <Label className={hideLabel ? 'sr-only' : undefined}>{t('Runtime dependencies')}</Label>
          <div className="dependency-picker-options">
            {rows.map(row => (
              <Checkbox key={row.name} value={row.name} isDisabled={!row.current && !value.includes(row.name)}>
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <Label>{row.name}</Label>
                </Checkbox.Content>
              </Checkbox>
            ))}
          </div>
          {rows.length === 0 ? <p>{t('No runtime dependencies yet')}</p> : null}
        </CheckboxGroup>
      )}
      {readOnly ? null : (
        <a href="/admin/runtime-dependencies" target="_blank" rel="noreferrer">
          {t('Manage runtime dependencies')}
        </a>
      )}
    </div>
  )
}
