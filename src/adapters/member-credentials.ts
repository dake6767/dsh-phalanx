import { MEMBER_CREDENTIAL_COMMAND } from '../dsh/container.js'
import type { MemberCredentialsPort } from '../ports/member-credentials.js'
import { CommunityRuntimeUnavailableError } from '../ports/community-runtime.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'

export class ContainerMemberCredentials implements MemberCredentialsPort {
  constructor(
    private readonly runtime: string,
    private readonly currentCarrier: () => Promise<string>,
  ) {}
  async lookup(attributes: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.access('lookup', attributes, signal)
    if (result === null) return undefined
    if (typeof result !== 'string') throw unavailable()
    return result
  }
  async store(attributes: Readonly<Record<string, string>>, value: string, signal?: AbortSignal): Promise<void> {
    if ((await this.access('store', attributes, signal, value)) !== true) throw unavailable()
  }
  async clear(attributes: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<void> {
    if ((await this.access('clear', attributes, signal)) !== true) throw unavailable()
  }
  private async access(
    operation: 'lookup' | 'store' | 'clear',
    attributes: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    value?: string,
  ): Promise<unknown> {
    signal?.throwIfAborted()
    try {
      const carrier = await this.currentCarrier()
      signal?.throwIfAborted()
      const output = await execFileText(this.runtime, ['exec', '-i', carrier, ...MEMBER_CREDENTIAL_COMMAND, '--access'], {
        input: JSON.stringify({ operation, attributes: Object.entries(attributes), value }),
        env: containerClientEnvironment(),
        timeout: 10_000,
        maxBuffer: 131_072,
        ...(signal ? { signal } : {}),
      })
      return JSON.parse(output) as unknown
    } catch {
      signal?.throwIfAborted()
      // Child errors can contain command output. Report only the stable, non-secret failure.
      throw unavailable()
    }
  }
}

const unavailable = () => new CommunityRuntimeUnavailableError('credentials-unavailable', 'The private credential service is unavailable')
