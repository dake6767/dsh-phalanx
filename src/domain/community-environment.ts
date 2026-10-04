import type { CommunityEnvironmentBackup, CommunityEnvironmentResetFailure } from './admin-contract.js'

export class CommunityEnvironmentRecoveryError extends Error {
  constructor(readonly phase: CommunityEnvironmentResetFailure['phase'], readonly backup?: CommunityEnvironmentBackup, options?: ErrorOptions) {
    super(phase === 'backup' ? 'Backup failed. The original DSH environment was not reset; resolve backup storage and retry.'
      : phase === 'stop' ? 'The user instance could not be stopped. The DSH environment was not reset.'
      : `Environment recovery failed during ${phase}. The completed backup is preserved; follow its restore instructions or retry.`, options)
  }
}
