/** Public product entry; account preparation uses the product HTTP interface. */
export interface CommunityApplication {
  start(): Promise<string>
  stop(): Promise<void>
}
