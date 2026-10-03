import { request as httpRequest } from 'node:http'
import { launchExchangeCookies } from '../dsh/launch-token.js'
import { DSH_RPC_PREFIX, SESSION_LIST, rpcRequestBody, runningAgentFromResponse } from '../dsh/session-protocol.js'
import type { DshSessionPort } from '../ports/dsh-session.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'

const MAX_ACTIVITY_RESPONSE_BYTES = 1024 * 1024
const ACTIVITY_QUERY_TIMEOUT_MS = 10_000

/** Official launch authentication and activity query; native traffic is proxied unchanged. */
export class HttpDshSession implements DshSessionPort {
  exchangeLaunchToken = exchangeLaunchToken
  hasRunningAgent = hasRunningAgent
}

function exchangeLaunchToken(instance: CommunityUserInstance, publicOrigin: URL): Promise<string[]> {
  const launch = new URL(instance.launchUrl)
  return new Promise((resolveCookies, reject) => {
    const request = httpRequest({
      protocol: launch.protocol,
      hostname: launch.hostname,
      port: launch.port,
      method: 'GET',
      path: `${launch.pathname}${launch.search}`,
      headers: { host: publicOrigin.host },
    }, response => {
      response.resume()
      response.once('end', () => {
        try { resolveCookies(launchExchangeCookies(response.statusCode, response.headers['set-cookie'])) }
        catch (error) { reject(error) }
      })
    })
    request.once('error', reject)
    request.end()
  })
}

function hasRunningAgent(instance: CommunityUserInstance, cookie: string, publicOrigin: URL): Promise<boolean> {
  const endpoint = SESSION_LIST
  const body = rpcRequestBody(`dsh-phalanx-reclaim-${String(Date.now())}`, endpoint, { _request: {} })
  const target = new URL(`${DSH_RPC_PREFIX}${endpoint}`, instance.origin)
  return new Promise((resolveRunning, reject) => {
    let settled = false
    const timing: { deadline?: NodeJS.Timeout } = {}
    const finish = (error: Error | undefined, running?: boolean): void => {
      if (settled) return
      settled = true
      if (timing.deadline !== undefined) clearTimeout(timing.deadline)
      if (error !== undefined) reject(error)
      else resolveRunning(running ?? false)
    }
    const request = httpRequest({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: 'POST',
      path: target.pathname,
      headers: {
        host: publicOrigin.host,
        cookie,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, response => {
      const chunks: Buffer[] = []
      let receivedBytes = 0
      response.on('data', chunk => {
        const buffer = Buffer.from(chunk as Uint8Array)
        receivedBytes += buffer.length
        if (receivedBytes > MAX_ACTIVITY_RESPONSE_BYTES) {
          response.destroy(new Error('DSH activity query response exceeded its size limit'))
          return
        }
        chunks.push(buffer)
      })
      response.once('error', error => finish(error))
      response.once('aborted', () => finish(new Error('DSH activity query response was aborted')))
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (response.statusCode !== 200) {
          finish(new Error(`DSH activity query returned HTTP ${String(response.statusCode)}`))
          return
        }
        try {
          finish(undefined, runningAgentFromResponse(text))
        } catch (error) {
          finish(error instanceof Error ? error : new Error('DSH activity query returned invalid JSON'))
        }
      })
    })
    timing.deadline = setTimeout(() => {
      request.destroy(new Error(`DSH activity query timed out after ${String(ACTIVITY_QUERY_TIMEOUT_MS)} ms`))
    }, ACTIVITY_QUERY_TIMEOUT_MS)
    request.once('error', error => finish(error))
    request.end(body)
  })
}
