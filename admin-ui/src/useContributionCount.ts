import { useEffect, useState } from 'react'
import { communityContributionCounts } from './community-api'
export const contributionsChanged = 'community-contributions-changed'
export function useContributionCount(kind: 'skills' | 'plugins' = 'skills') {
  const [count, setCount] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const value = await communityContributionCounts(controller.signal)
        if (!controller.signal.aborted) setCount(value[kind] ?? 0)
      } catch {
        /* The contribution page owns retrieval errors. */
      }
    }
    const poll = async () => {
      await load()
      if (!controller.signal.aborted) timer = setTimeout(poll, 15000)
    }
    const changed = () => {
      void load()
    }
    void poll()
    window.addEventListener(contributionsChanged, changed)
    return () => {
      controller.abort()
      clearTimeout(timer)
      window.removeEventListener(contributionsChanged, changed)
    }
  }, [kind])
  return count
}
