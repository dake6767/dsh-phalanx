import type { CommunityApiErrorBody, CommunityErrorCode, CommunityErrorParams } from './admin-contract.js'

export interface EnvironmentBackup { readonly id: string, readonly location: string, readonly restoreInstructions: string, readonly restoreInstructionsPath?: string }
export interface EnvironmentResetResult { readonly username: string, readonly spaceId: string, readonly entry: string, readonly backup: EnvironmentBackup }
export interface EnvironmentResetConfirmation { readonly confirmed: true }
export interface EnvironmentResetFailure extends CommunityApiErrorBody { readonly phase: 'stop' | 'backup' | 'reset' | 'start', readonly backup?: EnvironmentBackup }
export type SelfEnvironmentResetResult = Pick<EnvironmentResetResult, 'entry'>
export type SelfEnvironmentResetFailure = Omit<EnvironmentResetFailure, 'backup'>

export class CommunityEnvironmentRecoveryError extends Error {
  readonly code: CommunityErrorCode
  readonly params: CommunityErrorParams
  constructor(readonly phase: EnvironmentResetFailure['phase'], readonly backup?: EnvironmentBackup, options?: ErrorOptions) {
    super(phase === 'backup' ? 'Backup failed. The original DSH environment was not reset; resolve backup storage and retry.'
      : phase === 'stop' ? 'The user instance could not be stopped. The DSH environment was not reset.'
      : `Environment recovery failed during ${phase}. The completed backup is preserved; follow its restore instructions or retry.`, options)
    this.code = 'environment-recovery-failed'; this.params = { phase }
  }
}
