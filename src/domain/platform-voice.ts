export type PlatformVoiceFailureCode = 'download' | 'integrity' | 'storage'

export class PlatformVoicePreparationError extends Error {
  constructor(
    readonly code: PlatformVoiceFailureCode,
    options?: ErrorOptions,
  ) {
    super('Voice model preparation failed', options)
  }
}
