import { expect } from 'vitest'
import { communityEntryUrl } from './community-space.js'

/** Follow the same first-page navigation and native session exchange as a browser. */
export async function openCommunityHttpEntry(origin: string, platformCookie: string, timeout = 15_000): Promise<{ response: Response; cookie: string }> {
  const url = communityEntryUrl(origin, platformCookie)
  let response = await fetch(url, { headers: { cookie: platformCookie, accept: 'text/html' }, redirect: 'manual' })
  expect(response.status).toBe(200)
  if ((await response.clone().text()).includes('data-platform-startup')) {
    let state = ''
    await expect
      .poll(
        async () => {
          const status = await fetch(origin + '/account/startup', { headers: { cookie: platformCookie } })
          expect(status.status).toBe(200)
          state = ((await status.json()) as { state: string }).state
          return state
        },
        { timeout },
      )
      .toMatch(/^(ready|failed)$/u)
    expect(state).toBe('ready')
    response = await fetch(url, { headers: { cookie: platformCookie, accept: 'text/html' }, redirect: 'manual' })
    expect(response.status).toBe(200)
    expect(await response.clone().text()).not.toContain('data-platform-startup')
  }
  const pairs = new Map(
    platformCookie
      .split(';')
      .map(value => value.trim())
      .filter(Boolean)
      .map(pair => [pair.split('=')[0]!, pair]),
  )
  for (const setCookie of response.headers.getSetCookie()) {
    const pair = setCookie.split(';')[0]!
    pairs.set(pair.split('=')[0]!, pair)
  }
  return { response, cookie: [...pairs.values()].join('; ') }
}
