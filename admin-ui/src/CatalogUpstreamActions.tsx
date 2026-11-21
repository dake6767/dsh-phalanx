import { useEffect, useState } from 'react'
import { Button } from '@heroui/react/button'
import { communityPluginUpstreams } from './community-api'
import { usePlatformLanguage } from './CommunityLanguage'
import type { CommunitySuiteCatalogEntryView } from '../../src/domain/admin-contract'

export default function CatalogUpstreamActions({
  plugin,
  onConfigure,
}: {
  plugin: NonNullable<CommunitySuiteCatalogEntryView['plugin']>
  onConfigure: (packageName: string, name: string) => void
}) {
  const { t } = usePlatformLanguage()
  const [pending, setPending] = useState<readonly string[]>([])
  const { packageName, deferredUpstreams } = plugin
  useEffect(() => {
    const controller = new AbortController()
    void communityPluginUpstreams(packageName, controller.signal)
      .then(rows => {
        if (!controller.signal.aborted) setPending(rows.filter(row => row.managedImage?.ready === false).map(row => row.name))
      })
      .catch(() => {
        if (!controller.signal.aborted) setPending([])
      })
    return () => controller.abort()
  }, [packageName, deferredUpstreams])
  return pending
    .filter(name => deferredUpstreams?.includes(name))
    .map(name => (
      <Button className="relative z-10" key={name} size="sm" variant="secondary" onPress={() => onConfigure(packageName, name)}>
        {t('Upstream setup required')}
      </Button>
    ))
}
