import { expect } from 'vitest'
import type { APIResponse } from 'playwright'

export async function bootstrapInstalledUpgrade({
  run,
  platformPid,
  expectedPid,
  platformStatus,
  candidate,
  requests,
}: {
  run: () => Promise<string>
  platformPid: () => Promise<string>
  expectedPid: string
  platformStatus: (() => Promise<number>) | undefined
  candidate: string
  requests: readonly string[]
}) {
  if (platformStatus) expect(await platformStatus()).toBe(200)
  const requestStart = requests.length
  const result = JSON.parse(await run())
  expect(result).toMatchObject({ status: 'updater-ready', executor: { sourceCommit: candidate }, operation: null })
  expect(await platformPid()).toBe(expectedPid)
  if (platformStatus) expect(await platformStatus()).toBe(200)
  const downloads = requests.slice(requestStart)
  expect(downloads.length).toBeGreaterThan(0)
  expect(downloads.every(url => url.endsWith('/updater.json'))).toBe(true)
  return { executor: result.executor, platformPidUnchanged: true, smallUpdaterOnly: true, requests: downloads }
}

export async function checkBootstrappedUpdater({
  check,
  version,
  platformPid,
  expectedPid,
}: {
  check: () => Promise<APIResponse>
  version: string
  platformPid: () => Promise<string>
  expectedPid: string
}) {
  let result: { check: { status: string; version: string } } | undefined
  await expect
    .poll(
      async () => {
        try {
          const response = await check()
          if (response.status() !== 200) return 'unavailable'
          result = await response.json()
          return result?.check.status
        } catch {
          return 'unavailable'
        }
      },
      { timeout: 300000 },
    )
    .toBe('available')
  expect(result?.check).toMatchObject({ status: 'available', version })
  expect(await platformPid()).toBe(expectedPid)
  return { check: result!.check, releaseBoundExecutor: true, platformPidUnchanged: true }
}
