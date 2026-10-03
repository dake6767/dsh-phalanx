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
