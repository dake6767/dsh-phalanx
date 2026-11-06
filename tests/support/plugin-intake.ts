import { expect } from 'vitest'
import type { CommunityPluginPreview, CommunityPluginView } from '../../src/domain/admin-contract.js'

type ManagementRequest = (path: string, body?: object) => Promise<unknown>
/** Exercise the public two-step intake; accept the fixtures' JSON, Fetch and browser transports. */
export async function prepareAndConfirmNpmPlugin(request: ManagementRequest, input: string, timeout = 120_000): Promise<CommunityPluginView> {
  const json = async (path: string, body?: object, expectedStatus = 200): Promise<unknown> => {
    const value = await request(path, body)
    if (value && typeof value === 'object' && 'json' in value && typeof value.json === 'function' && 'status' in value) {
      const response = value as { status: number | (() => number); json(): Promise<unknown> }
      expect(typeof response.status === 'function' ? response.status() : response.status).toBe(expectedStatus)
      return response.json()
    }
    return value
  }
  let preview = (await json('plugins/previews', { input }, 202)) as CommunityPluginPreview
  expect(preview.token).toEqual(expect.any(String))
  await expect
    .poll(
      async () => {
        preview = (await json('plugins/previews?token=' + encodeURIComponent(preview.token))) as CommunityPluginPreview
        return preview.stage === 'ready' || preview.stage === 'failed'
      },
      { timeout },
    )
    .toBe(true)
  expect(preview.stage, preview.failureCode).toBe('ready')
  const confirmed = (await json('plugins/previews/confirm', { token: preview.token })) as CommunityPluginView
  expect(confirmed).toMatchObject({
    packageName: preview.packageName,
    version: preview.version,
    currentVersion: preview.version,
    stage: 'available',
    published: false,
  })
  return confirmed
}

export function prepareAndConfirmNpmPluginInBrowser(
  request: import('playwright').APIRequestContext,
  origin: string,
  input: string,
  timeout?: number,
): Promise<CommunityPluginView> {
  return prepareAndConfirmNpmPlugin(
    (path, body) =>
      body === undefined ? request.get(origin + '/admin/api/' + path) : request.post(origin + '/admin/api/' + path, { headers: { origin }, data: body }),
    input,
    timeout,
  )
}
