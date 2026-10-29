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
}: {
  value: readonly string[]
  onChange: (names: string[]) => void
  disabled?: boolean
  items?: readonly CommunityRuntimeDependencyView[]
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
    <div className="page-stack">
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
        <CheckboxGroup value={[...value]} onChange={onChange} isDisabled={disabled}>
          <Label>{t('Runtime dependencies')}</Label>
          {rows.map(row => (
            <Checkbox key={row.name} value={row.name} isDisabled={!row.current && !value.includes(row.name)}>
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <Label>{row.name}</Label>
              </Checkbox.Content>
              <p className="text-sm text-muted">{row.current ? row.current.commands.join(', ') : t('No usable dependency version')}</p>
            </Checkbox>
          ))}
          {rows.length === 0 ? <p>{t('No runtime dependencies yet')}</p> : null}
        </CheckboxGroup>
      )}
      <a href="/admin/runtime-dependencies" target="_blank" rel="noreferrer">
        {t('Manage runtime dependencies')}
      </a>
    </div>
  )
}
