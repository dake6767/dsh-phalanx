export interface PreparedExecution {
  readonly id: string
  readonly version: string
  readonly hash: string
  readonly log: string
}
export interface ExecutionPreparationRecord {
  readonly identity: string
  readonly stage: 'preparing' | 'ready' | 'failed'
  readonly updatedAt: number
  readonly log: string
  readonly artifact?: PreparedExecution
}

export class ExecutionPreparationFailure extends Error {
  constructor(readonly log: string) { super('Execution preparation failed') }
}
