import type { CommunityConfig } from './community-config.js'

/** Validate the deployment settings before constructing any runtime resources. */
export function validateConfig(config: CommunityConfig): void {
  if (config.registration !== undefined && config.registration.enabled !== false) {
    throw new Error('open registration is unavailable in 0.1.0')
  }
  if (config.listen.host.length === 0) throw new Error('listen host must not be empty')
  if (!Number.isInteger(config.listen.port) || config.listen.port < 0 || config.listen.port > 65_535) {
    throw new Error('listen port must be an integer between 0 and 65535')
  }
  if (config.runtime.command.length === 0) throw new Error('runtime command must not be empty')
  if (config.runtime.dataRoot.length === 0) throw new Error('runtime data root must not be empty')
  if (config.runtime.container !== undefined) {
    if (config.runtime.container.runtime.length === 0) throw new Error('container runtime must not be empty')
    if (config.runtime.container.image.length === 0) throw new Error('container image must not be empty')
    for (const [name, port] of [
      ['container internal port', config.runtime.container.internalPort],
      ['container gateway port', config.runtime.container.gatewayPort],
    ] as const) {
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`${name} must be an integer between 1 and 65535`)
      }
    }
  }
  if (config.runtime.defaultModel.provider !== 'deepseek-official') {
    throw new Error('the first dsh-phalanx model gateway supports only the deepseek-official provider')
  }
  if (config.runtime.defaultModel.model.length === 0) throw new Error('allowed model must not be empty')
  const upstream = new URL(config.runtime.defaultModel.upstream.baseUrl)
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username !== '' || upstream.password !== '' || upstream.search !== '' || upstream.hash !== '') {
    throw new Error('model upstream base URL must use HTTP(S) without credentials, query, or fragment')
  }
  if (config.listen.publicOrigin !== undefined) {
    const origin = new URL(config.listen.publicOrigin)
    if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') {
      throw new Error('public origin must be an HTTP(S) origin without path, query, or fragment')
    }
  }
  if (config.idleReclaimSeconds !== undefined
    && (!Number.isSafeInteger(config.idleReclaimSeconds) || config.idleReclaimSeconds < 0)) {
    throw new Error('idle reclaim seconds must be a non-negative integer')
  }
}
