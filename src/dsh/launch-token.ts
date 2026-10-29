/** The frozen DSH launch URL exchange redirects with at least one cookie. */
export function launchExchangeCookies(status: number | undefined, cookies: readonly string[] | undefined): string[] {
  if (status !== 303 || cookies === undefined || cookies.length === 0) {
    throw new Error(`DSH launch-token exchange returned HTTP ${String(status)}`)
  }
  return [...cookies]
}

export function cookiePair(cookie: string): string {
  const pair = cookie.split(';', 1)[0]
  if (pair === undefined || pair === '') throw new Error('DSH returned an invalid cookie')
  return pair
}

/** Forward only cookie name/value pairs to the official DSH session API. */
export function dshCookieHeader(cookies: readonly string[]): string {
  return cookies.map(cookiePair).join('; ')
}

/** Recognize only the cookie pairs returned by this instance's official exchange. */
/** Apply newly exchanged credentials to this first navigation before the browser receives Set-Cookie. */
export function mergeLaunchCookies(header: string | undefined, cookies: readonly string[]): string {
  const pairs = new Map(
    (header ?? '')
      .split(';')
      .map(value => value.trim())
      .filter(Boolean)
      .map(pair => [pair.split('=')[0]!, pair]),
  )
  for (const cookie of cookies) {
    const pair = cookiePair(cookie)
    pairs.set(pair.split('=')[0]!, pair)
  }
  return [...pairs.values()].join('; ')
}

export function hasLaunchCookies(cookies: readonly string[], header: string | undefined): boolean {
  if (!header || !cookies.length) return false
  const supplied = new Set(header.split(';').map(pair => pair.trim()))
  return cookies.every(cookie => supplied.has(cookiePair(cookie)))
}
