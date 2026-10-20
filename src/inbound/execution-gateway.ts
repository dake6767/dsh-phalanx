import type { UsageMember } from '../domain/usage-record.js'
import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EXECUTION_UNAVAILABLE_EXIT, ExecutionFailure } from '../domain/platform-execution.js'
import type { PlatformExecution } from '../use-cases/platform-execution.js'
import type { CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import { CommunityModelAccessError } from '../domain/community-model.js'
import { readCommunityJson } from './community-request.js'
import { downstreamAbort } from './upstream-stream.js'

export function createExecutionGateway(execution: PlatformExecution, authorization: CommunityModelAuthorization, connections: Pick<SessionRegistryPort, 'track' | 'untrack'>) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const { controller, cleanup } = downstreamAbort(request, response)
    const send = async (event: unknown, terminal = false) => {
      if (response.destroyed) throw new Error('Execution connection closed')
      if (!response.headersSent) response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/x-ndjson' })
      if (!response.write(JSON.stringify(event) + '\n') && !terminal) await once(response, 'drain', { signal: controller.signal })
    }
    try {
      if (request.method !== 'POST') throw new ExecutionFailure('internal')
      let member: UsageMember | undefined, username: string | undefined, accessError: unknown
      try { username = authorization.authorize(request.headers['x-api-key'], value => { member = value }) }
      catch (error) { if (!member) throw error; accessError = error }
      let input: Record<string, unknown>
      try { input = await readCommunityJson(request, 24 * 1024 * 1024) as Record<string, unknown>
      if (!input || typeof input !== 'object' || typeof input.owner !== 'string' || input.owner.length > 256
        || typeof input.command !== 'string' || input.command.length > 256 || typeof input.cwd !== 'string' || input.cwd.length > 4096
        || typeof input.stdin !== 'string' || Buffer.from(input.stdin, 'base64').toString('base64') !== input.stdin
        || !Array.isArray(input.argv) || input.argv.length > 4096 || input.argv.some(value => typeof value !== 'string' || value.includes('\0')))
        throw new ExecutionFailure('internal')
      } catch (error) { throw accessError ?? error }
      const metadata = { owner: input.owner as string, command: input.command as string, argv: input.argv as string[] }
      try { if (accessError) throw accessError; authorization.authorize(request.headers['x-api-key']) }
      catch (error) { if (member) execution.recordRefusal(member, metadata); throw error }
      connections.track(username!, request.socket)
      const exit = await execution.execute({ username: username!, ...metadata, cwd: input.cwd as string, stdin: Buffer.from(input.stdin as string, 'base64') },
        async event => { await send({ stream: event.stream, data: Buffer.from(event.data).toString('base64') }) }, controller.signal, member)
      await send({ exit }, true)
    } catch (error) {
      if (!response.destroyed && !controller.signal.aborted) {
        const failure = error instanceof ExecutionFailure ? error : new ExecutionFailure(error instanceof CommunityModelAccessError ? 'unauthorized' : 'internal')
        await send({ stream: 'stderr', data: Buffer.from(failure.message + '\n').toString('base64') }, true); await send({ exit: EXECUTION_UNAVAILABLE_EXIT }, true)
      }
    } finally { cleanup(); connections.untrack(request.socket); response.end() }
  }
}
