import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EXECUTION_UNAVAILABLE_EXIT, ExecutionFailure } from '../domain/platform-execution.js'
import type { PlatformExecution } from '../use-cases/platform-execution.js'
import type { CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import { CommunityModelAccessError } from '../domain/community-model.js'
import { readCommunityJson } from './community-request.js'
import { downstreamAbort } from './upstream-stream.js'

export function createExecutionGateway(execution: PlatformExecution, authorization: CommunityModelAuthorization, connections: SessionRegistryPort) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const { controller, cleanup } = downstreamAbort(request, response)
    const send = async (event: unknown, terminal = false) => {
      if (response.destroyed) throw new Error('Execution connection closed')
      if (!response.headersSent) response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/x-ndjson' })
      if (!response.write(JSON.stringify(event) + '\n') && !terminal) await once(response, 'drain', { signal: controller.signal })
    }
    try {
      if (request.method !== 'POST') throw new ExecutionFailure('internal')
      const username = authorization.authorize(request.headers['x-api-key'])
      const input = await readCommunityJson(request, 24 * 1024 * 1024) as Record<string, unknown>
      if (!input || typeof input !== 'object' || typeof input.owner !== 'string' || input.owner.length > 256
        || typeof input.command !== 'string' || input.command.length > 256 || typeof input.cwd !== 'string' || input.cwd.length > 4096
        || typeof input.stdin !== 'string' || Buffer.from(input.stdin, 'base64').toString('base64') !== input.stdin
        || !Array.isArray(input.argv) || input.argv.length > 4096 || input.argv.some(value => typeof value !== 'string' || value.includes('\0')))
        throw new ExecutionFailure('internal')
      authorization.authorize(request.headers['x-api-key']); connections.track(username, request.socket)
      const exit = await execution.execute({ username, owner: input.owner, command: input.command, cwd: input.cwd, argv: input.argv as string[], stdin: Buffer.from(input.stdin, 'base64') },
        async event => { await send({ stream: event.stream, data: Buffer.from(event.data).toString('base64') }) }, controller.signal)
      await send({ exit }, true)
    } catch (error) {
      if (!response.destroyed && !controller.signal.aborted) {
        const failure = error instanceof ExecutionFailure ? error : new ExecutionFailure(error instanceof CommunityModelAccessError ? 'unauthorized' : 'internal')
        await send({ stream: 'stderr', data: Buffer.from(failure.message + '\n').toString('base64') }, true); await send({ exit: EXECUTION_UNAVAILABLE_EXIT }, true)
      }
    } finally { cleanup(); connections.untrack(request.socket); response.end() }
  }
}
