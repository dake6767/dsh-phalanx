import { isIP } from 'node:net'

/** The frozen DSH web CLI readiness line, shared by process and container launches. */
export const DSH_READY_PATTERN = /dsh web: (http:\/\/\S+)/u

/** Frozen DSH reports optional plugin activation failures before Web readiness. */
export const DSH_INACTIVE_ENTRY_PATTERN = /(?:^|\n)dsh: warning: \d+ (?:entry|entries) did not activate\b/u

export function findReadinessLine(logs: string): string | undefined {
  let found: string | undefined
  for (const line of logs.split('\n')) {
    const match = DSH_READY_PATTERN.exec(line)
    if (match?.[1] !== undefined) found = match[1]
  }
  return found
}

/** Accept only one unauthenticated loopback launch-token URL. */
export function validateLaunchUrl(value: string): URL {
  const url = new URL(value)
  const loopback = url.hostname === 'localhost' || url.hostname === '::1' || isIP(url.hostname) === 4 && url.hostname.startsWith('127.')
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== '') {
    throw new Error('DSH readiness URL must use unauthenticated loopback HTTP')
  }
  if (url.pathname !== '/' || url.searchParams.getAll('token').length !== 1) {
    throw new Error('DSH readiness URL did not contain one root launch token')
  }
  return url
}
