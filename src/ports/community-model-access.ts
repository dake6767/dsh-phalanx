/** Scoped opaque access; never a signed platform KEY or upstream credential. */
export interface CommunityModelAccessPort {
  forUser(username: string): string
  resolve(token: string): string | undefined
}
