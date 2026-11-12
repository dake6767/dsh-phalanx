import { useEffect, useRef, useState } from 'react'
import type { CommunityNativeFeatureGroup } from '../../src/domain/admin-contract'
import { request } from './community-api'

export function useNativeFeatures(groupId: string, onError: (failure: unknown) => void) {
  const [data, setData] = useState<CommunityNativeFeatureGroup>()
  const [disabled, setDisabled] = useState<readonly string[]>([])
  const [showAppCenter, setShowAppCenter] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<'native' | 'platform'>()
  const pending = useRef(false)
  const errors = useRef(onError)
  errors.current = onError
  const apply = (next: CommunityNativeFeatureGroup) => {
    setData(next)
    setShowAppCenter(next.showAppCenter)
    setDisabled(
      next.features
        .filter(feature => feature.availability.available && !feature.enabled)
        .map(feature => feature.id)
        .sort(),
    )
  }
  useEffect(() => {
    const controller = new AbortController()
    setData(undefined)
    setDisabled([])
    setShowAppCenter(false)
    setSaved(undefined)
    void request<CommunityNativeFeatureGroup>(`/admin/api/groups/${encodeURIComponent(groupId)}/native-features`, { signal: controller.signal })
      .then(next => {
        if (!controller.signal.aborted) apply(next)
      })
      .catch(failure => {
        if (!controller.signal.aborted) errors.current(failure)
      })
    return () => controller.abort()
  }, [groupId])
  const nativeDirty =
    data !== undefined &&
    JSON.stringify([...disabled].sort()) !==
      JSON.stringify(
        data.features
          .filter(feature => feature.availability.available && !feature.enabled)
          .map(feature => feature.id)
          .sort(),
      )
  const platformDirty = data !== undefined && showAppCenter !== data.showAppCenter
  const dirty = nativeDirty || platformDirty
  const save = async () => {
    if (!data || !dirty || pending.current) return false
    const changes = {
      ...(nativeDirty ? { disabledIds: disabled } : {}),
      ...(platformDirty ? { showAppCenter } : {}),
    }
    pending.current = true
    setBusy(true)
    errors.current(undefined)
    try {
      const next = await request<CommunityNativeFeatureGroup>(`/admin/api/groups/${encodeURIComponent(groupId)}/native-features`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: data.revision, ...changes }),
      })
      apply(next)
      setSaved(nativeDirty ? 'native' : 'platform')
      return true
    } catch (failure) {
      errors.current(failure)
      return false
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return {
    data,
    disabled,
    showAppCenter,
    setShowAppCenter: (show: boolean) => {
      setShowAppCenter(show)
      setSaved(undefined)
    },
    setDisabled: (ids: readonly string[]) => {
      setDisabled(ids)
      setSaved(undefined)
    },
    dirty,
    busy,
    save,
    saved,
    discard: () => {
      if (data) apply(data)
    },
  }
}
