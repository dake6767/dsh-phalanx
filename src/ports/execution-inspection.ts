export interface ExecutionSuggestions {
  readonly commands: readonly string[]
  readonly variables: readonly string[]
  readonly prepare?: string
}
export interface ExecutionInspectionPort {
  inspect(version: string): Promise<ExecutionSuggestions>
  available(version: string, command: string): Promise<boolean>
}
