import type { Duplex } from 'node:stream'
import type { CommunityUserInstance } from './community-runtime.js'

/** Validated platform login; the opaque key never leaves the platform gateway. */
export interface PreviewIdentity {
  readonly userId: string
  readonly spaceId: string
  readonly sessionEpoch: number
  readonly expiresAt: number
  readonly key: string
}
export interface PreviewTarget {
  readonly identity: PreviewIdentity
  readonly instance: CommunityUserInstance
  readonly port: number
}
export interface ServicePreviewTransportPort {
  connect(target: PreviewTarget): Duplex
}
export class ServicePreviewError extends Error {
  constructor(readonly status: 403 | 503, message: string) { super(message) }
}

/** Cryptographic entropy is supplied at the adapter boundary. */
export interface PreviewCapabilityPort { issue(): string }
