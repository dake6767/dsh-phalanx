import { useEffect, useState } from 'react'
import type { CommunitySuiteCatalogEntryView } from '../../src/domain/admin-contract'
import { suiteOriginName } from '../../src/domain/suite-catalog'
import { communitySuites } from './community-api'

/** Resolve badges from the current online directory without blocking the local library. */
export function useSuiteOriginName(locale: 'en' | 'zh-CN', enabled: boolean) {
  const [entries, setEntries] = useState<readonly CommunitySuiteCatalogEntryView[]>([])
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    void communitySuites(controller.signal)
      .then(view => {
        if (!controller.signal.aborted) setEntries(view.entries)
      })
      .catch(() => {
        if (!controller.signal.aborted) setEntries([])
      })
    return () => controller.abort()
  }, [enabled])
  return (origin: string) => suiteOriginName(origin, locale, entries)
}
