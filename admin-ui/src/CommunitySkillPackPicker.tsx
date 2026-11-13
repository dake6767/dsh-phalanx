import { useEffect, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Checkbox } from '@heroui/react/checkbox'
import type { CommunitySkillPackCandidates, CommunitySkillPackMember } from '../../src/domain/skill-admin-contract'
import { communitySkillPackCandidates } from './community-api'
import CommunityDialog from './CommunityDialog'
import CommunityField from './CommunityField'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityMessage from './CommunityMessage'

export default function CommunitySkillPackPicker({
  current,
  onAdd,
  onClose,
}: {
  current: readonly string[]
  onAdd: (rows: readonly CommunitySkillPackMember[]) => void
  onClose: () => void
}) {
  const { t, errorText } = usePlatformLanguage()
  const [selected, setSelected] = useState<readonly CommunitySkillPackMember[]>([])
  const [search, setSearch] = useState('')
  const [history, setHistory] = useState<readonly string[]>([''])
  const [result, setResult] = useState<CommunitySkillPackCandidates>()
  const [error, setError] = useState<unknown>()
  const [reload, setReload] = useState(0)
  const cursor = history.at(-1)!
  const full = current.length + selected.length >= 256
  const nextCursor = result?.next
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void communitySkillPackCandidates(search, cursor, controller.signal)
        .then(value => {
          if (!controller.signal.aborted) setResult(value)
        })
        .catch(failure => {
          if (!controller.signal.aborted) setError(failure)
        })
    }, 180)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [search, cursor, reload])

  const page = (next: readonly string[]) => {
    setResult(undefined)
    setError(undefined)
    setHistory(next)
  }
  return (
    <CommunityDialog
      title={t('Add skills')}
      onClose={onClose}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            {t('Cancel')}
          </Button>
          <Button isDisabled={!selected.length} onPress={() => onAdd(selected)}>
            {t('Add selected skills')}
          </Button>
        </>
      }
    >
      <div className="page-stack">
        <CommunityField
          autoFocus
          label={t('Search library skills')}
          value={search}
          onChange={value => {
            if (value === search || value.length > 256) return
            setSearch(value)
            page([''])
          }}
        />
        <p role="status">{t('{count} selected', { count: selected.length })}</p>
        {full ? <p>{t('A pack can contain at most 256 skills.')}</p> : null}
        {error ? (
          <CommunityMessage status="danger" role="alert" title={errorText(error)}>
            <Button
              variant="secondary"
              onPress={() => {
                setError(undefined)
                setReload(value => value + 1)
              }}
            >
              {t('Reload skills')}
            </Button>
          </CommunityMessage>
        ) : !result ? (
          <p role="status">{t('Loading…')}</p>
        ) : !result.rows.length ? (
          <p>{t('No skills match this filter.')}</p>
        ) : (
          <ul className="grant-rows">
            {result.rows.map(row => {
              const present = current.includes(row.name)
              const checked = selected.some(item => item.name === row.name)
              return (
                <li key={row.name}>
                  <div className="grant-row-main">
                    <Checkbox
                      isSelected={present || checked}
                      isDisabled={present || !!row.conflict || (full && !checked)}
                      onChange={add => {
                        setSelected(items =>
                          add ? (items.some(item => item.name === row.name) ? items : [...items, row]) : items.filter(item => item.name !== row.name),
                        )
                      }}
                    >
                      <Checkbox.Content>
                        <Checkbox.Control>
                          <Checkbox.Indicator />
                        </Checkbox.Control>
                        {row.name}
                      </Checkbox.Content>
                    </Checkbox>
                    <p>{row.description}</p>
                    {present ? <p>{t('Already in this pack')}</p> : row.conflict ? <p>{t('Skill is unavailable.')}</p> : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        <div className="catalog-entry-actions">
          <Button size="sm" variant="secondary" isDisabled={history.length === 1} onPress={() => page(history.slice(0, -1))}>
            {t('Previous page')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!nextCursor}
            onPress={() => {
              if (nextCursor) page([...history, nextCursor])
            }}
          >
            {t('Next page')}
          </Button>
        </div>
      </div>
    </CommunityDialog>
  )
}
