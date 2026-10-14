import type { ExecutionSuggestions } from '../domain/execution-suggestions.js'
export type { ExecutionSuggestions } from '../domain/execution-suggestions.js'
export interface ExecutionInspectionPort {
  inspect(version: string): Promise<ExecutionSuggestions>
  available(version: string, command: string): Promise<boolean>
}
