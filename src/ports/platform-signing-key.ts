/** The initialized platform owner supplies the same key to each scoped signing codec. */
export interface PlatformSigningKeyPort {
  read(): string
}
