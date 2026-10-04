/** Derive the public mount from the platform's own issued fixture cookie. Admission remains server-owned. */
export function communityEntryUrl(origin: string, cookie: string): string {
  const token = /(?:^|;\s*)dsh-phalanx_session=([^;]+)/u.exec(cookie)?.[1]
  if (token === undefined) return origin
  try {
    const identity = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as { spaceId?: unknown }
    return typeof identity.spaceId === 'string' ? new URL(`/app/${encodeURIComponent(identity.spaceId)}/`, origin).href : origin
  } catch { return origin }
}
