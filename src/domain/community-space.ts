/** Public identity is durable and contains no credential or filesystem mapping. */
export function communitySpacePath(spaceId: string): string {
  return `/app/${encodeURIComponent(spaceId)}/`
}
