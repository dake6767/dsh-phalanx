import type { PlatformVoicePrecision, PlatformVoiceSettingsChange, PlatformVoiceSettingsView } from '../domain/admin-contract.js'

export interface PreparedVoice {
  readonly precision: PlatformVoicePrecision
  readonly modelDirectory: string
  readonly vadModelPath: string
}

export interface PlatformVoiceAssetsPort {
  bytes(precision: PlatformVoicePrecision): number
  available(precision: PlatformVoicePrecision): Promise<PreparedVoice | undefined>
  prepare(precision: PlatformVoicePrecision, progress: (received: number) => void, signal: AbortSignal): Promise<PreparedVoice>
}

export type PlatformVoiceState = Omit<PlatformVoiceSettingsView, 'progress'>
export interface PlatformVoiceStore {
  state(): Promise<PlatformVoiceState>
  save(change: PlatformVoiceSettingsChange): Promise<PlatformVoiceState>
  settle(revision: number, result: { readonly ready: true } | { readonly failure: NonNullable<PlatformVoiceState['failure']> }): Promise<void>
}

export type MemberVoicePreference = 'offering' | 'offered' | 'suspended'
export interface MemberVoicePreferencesPort {
  preference(spaceId: string): Promise<MemberVoicePreference | undefined>
  remember(spaceId: string, state: MemberVoicePreference): Promise<void>
}
