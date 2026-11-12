import { request, type APIRequestContext, type Page } from 'playwright'
import { expect } from 'vitest'
import type { CommunityNativeFeatureGroup } from '../../src/domain/native-feature-contract.js'

export async function setAppCenterVisibility(admin: APIRequestContext, origin: string, groupId = 'default', showAppCenter = true) {
  const url = origin + '/admin/api/groups/' + encodeURIComponent(groupId) + '/native-features'
  const response = await admin.get(url)
  expect(response.ok(), await response.text()).toBe(true)
  const group = (await response.json()) as CommunityNativeFeatureGroup
  const saved = await admin.post(url, { headers: { origin }, data: { revision: group.revision, showAppCenter } })
  expect(saved.ok(), await saved.text()).toBe(true)
  expect(await saved.json()).toMatchObject({ showAppCenter })
}

export async function showAppCenterForFixture(origin: string, username: string, password: string) {
  const admin = await request.newContext()
  try {
    const login = await admin.post(origin + '/login', { headers: { origin }, form: { username, password }, maxRedirects: 0 })
    expect(login.status()).toBe(303)
    await setAppCenterVisibility(admin, origin)
  } finally {
    await admin.dispose()
  }
}

export const appCenterButton = (page: Page) => page.getByRole('button', { name: 'Platform App Center', exact: true })
export const appCenterPanel = (page: Page) => page.getByRole('region', { name: 'Platform App Center', exact: true })

export async function refreshAppCenter(page: Page, showAppCenter: boolean) {
  const settings = page.waitForResponse(response => new URL(response.url()).pathname === '/account/platform-features')
  await page.reload()
  const response = await settings
  expect(response.ok()).toBe(true)
  expect(response.headers()['cache-control']).toBe('no-store')
  expect(await response.json()).toEqual({ showAppCenter })
  await page.getByRole('button', { name: /^Platform account:/u }).waitFor()
  if (showAppCenter) await appCenterButton(page).waitFor()
  else {
    expect(await appCenterButton(page).count()).toBe(0)
    expect(await appCenterPanel(page).count()).toBe(0)
  }
}
