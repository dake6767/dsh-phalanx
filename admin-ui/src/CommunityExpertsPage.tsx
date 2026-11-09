import { useEffect, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Card } from '@heroui/react/card'
import { Chip } from '@heroui/react/chip'
import CommunityIcon from './CommunityIcon'
import type { CommunityExpertLibrary } from '../../src/domain/admin-contract'
import { communityExperts, publishCommunityExpert } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityExpertEditor from './CommunityExpertEditor'
import CommunityMessage from './CommunityMessage'
import CommunityExpertRemoval from './CommunityExpertRemoval'
import CommunitySelect from './CommunitySelect'

export default function CommunityExpertsPage() {
  const { t, errorText } = usePlatformLanguage()
  const [data, setData] = useState<CommunityExpertLibrary>(),
    [error, setError] = useState<unknown>(),
    [editing, setEditing] = useState<string>(),
    [revision, setRevision] = useState(0),
    [notice, setNotice] = useState(false),
    [filter, setFilter] = useState('all')
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        const value = await communityExperts(controller.signal)
        if (!controller.signal.aborted) {
          setData(value)
          setError(undefined)
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure)
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, 5000)
      }
    }
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [revision])
  const [removing, setRemoving] = useState<string>()
  const [publishing, setPublishing] = useState<string>()
  const publish = async (id: string, published: boolean) => {
    if (!data || publishing) return undefined
    setPublishing(id)
    setError(undefined)
    try {
      const next = await publishCommunityExpert(id, published, data.revision)
      setData(next)
      setNotice(true)
      return next
    } catch (failure) {
      setError(failure)
      return undefined
    } finally {
      setPublishing(undefined)
    }
  }
  const visible = data?.experts.filter(expert => filter === 'all' || (filter === 'published') === expert.published) ?? []
  return (
    <div className="community-page">
      <section className="page-heading plugin-page-heading">
        <div>
          <h1>{t('Experts')}</h1>
          <p>{t('Assemble a persona and library capabilities into a focused working mode.')}</p>
        </div>
        <Button className="primary-action" isDisabled={!data} onPress={() => setEditing('')}>
          <CommunityIcon name="plus" size={16} />
          {t('Create expert')}
        </Button>
      </section>
      {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
      {notice ? <CommunityMessage role="status" status="default" title={t('Expert changes take effect after members restart their instances.')} /> : null}
      <section className="panel plugin-library-panel" aria-label={t('All experts')}>
        <div className="panel-top panel-filter-header">
          <div>
            <div className="panel-title-row">
              <h2>{t('All experts')}</h2>
              <span className="panel-item-count">{t('{count} experts', { count: data ? visible.length : '—' })}</span>
            </div>
            <p>{t('Review publication, models and entry availability.')}</p>
          </div>
          <CommunitySelect
            className="panel-filter"
            hideLabel
            label={t('Filter by publication status')}
            value={filter}
            onChange={setFilter}
            options={[
              { id: 'all', label: t('All experts') },
              { id: 'published', label: t('Published expert') },
              { id: 'unpublished', label: t('Unpublished expert') },
            ]}
          />
        </div>
        {!data ? (
          <p className="table-empty" role="status">
            {t('Loading…')}
          </p>
        ) : visible.length === 0 ? (
          <Card className="plugin-library-empty" variant="transparent">
            <Card.Header>
              <Card.Title>{t(data.experts.length ? 'No experts match this filter.' : 'No experts yet')}</Card.Title>
              <Card.Description>{t('Create an expert to combine a persona with library capabilities.')}</Card.Description>
            </Card.Header>
          </Card>
        ) : (
          <div className="plugin-card-grid library-compact-grid expert-card-grid">
            {visible.map(expert => (
              <Card key={expert.id} className="plugin-library-card">
                <Card.Header>
                  <div className="library-card-heading">
                    <Card.Title>
                      <span className="expert-card-icon" aria-hidden="true">
                        {expert.icon || '✦'}
                      </span>
                      {expert.name}
                    </Card.Title>
                    <CommunityIcon name="chevron" size={14} />
                  </div>
                  <p className="plugin-summary-meta">
                    {expert.modelLabel ?? t('Host default model')} ·{' '}
                    {t('{count} skills and skill packs', { count: expert.skills.length + expert.skillPacks.length })}
                  </p>
                  <Card.Description>{expert.description}</Card.Description>
                </Card.Header>
                <Card.Footer className="plugin-card-status">
                  <div className="flex flex-wrap gap-2">
                    {expert.published ? (
                      <Chip size="sm" variant="soft" color="success">
                        {t('Published')}
                      </Chip>
                    ) : null}
                    {expert.checking?.length ? (
                      <Chip size="sm" variant="soft" color="accent">
                        {t('Checking capabilities…')}
                      </Chip>
                    ) : null}
                    {expert.reasoningUnavailable ? (
                      <Chip size="sm" color="warning">
                        {t('Reasoning unavailable')}
                      </Chip>
                    ) : null}
                    {expert.modelUnavailable ? (
                      <Chip size="sm" variant="soft" color="warning">
                        {t('Model unavailable')}
                      </Chip>
                    ) : null}
                    {expert.missing.length ? (
                      <Chip size="sm" variant="soft" color="warning">
                        {t('Unavailable entries')}
                      </Chip>
                    ) : null}
                    {expert.failures.length ? (
                      <Chip size="sm" variant="soft" color="danger">
                        {t('Load failed for {count} members', { count: expert.failures.length })}
                      </Chip>
                    ) : null}
                  </div>
                </Card.Footer>
                <Button
                  variant="tertiary"
                  size="sm"
                  className="plugin-details-action"
                  aria-label={t('Edit expert {name}', { name: expert.name })}
                  onPress={() => setEditing(expert.id)}
                />
              </Card>
            ))}
          </div>
        )}
        <div className="panel-footer plugin-library-note">
          <CommunityIcon name="shield" size={16} />
          <span>{t('Members granted this expert can use all its entries and platform credentials, including entries not granted separately.')}</span>
        </div>
      </section>
      {editing !== undefined && data ? (
        <CommunityExpertEditor
          key={editing}
          publishing={publishing !== undefined}
          onPublish={published => publish(editing, published)}
          onRemove={() => {
            setRemoving(editing)
          }}
          expert={data.experts.find(row => row.id === editing)}
          plugins={data.plugins}
          mcp={data.mcp}
          models={data.models}
          revision={data.revision}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined)
            setNotice(true)
            setRevision(value => value + 1)
          }}
        />
      ) : null}
      {removing ? (
        <CommunityExpertRemoval
          id={removing}
          onClose={() => setRemoving(undefined)}
          onRemoved={() => {
            setRemoving(undefined)
            setEditing(undefined)
            setNotice(true)
            setRevision(value => value + 1)
          }}
        />
      ) : null}
    </div>
  )
}
