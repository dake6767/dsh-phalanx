/** Metadata of a frozen preparation tree; business ownership lives in PostgreSQL. */
export interface PreparedExecution {
  readonly id: string
  readonly version: string
  readonly hash: string
  readonly log: string
}
