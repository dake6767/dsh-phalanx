import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserContext } from 'playwright'

export type RpcResult<T = unknown> = { ok: true, value: T } | { ok: false, error: { code: string, message: string } }

export function rpcBody(endpoint: string, args: object): string {
  return JSON.stringify({
    type: 'client-request',
    rpcId: `dsh-phalanx-${randomUUID()}`,
    method: endpoint,
    payload: { args },
  })
}

export function createRealDshRpc(unansweredDetail = '') {
  async function remoteRpcResult<T = unknown>(origin: string, cookie: string, endpoint: string, args: object): Promise<RpcResult<T>> {
    // Planned restarts answer 503 until the startup adoption gate opens.
    let response: Response | undefined
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const candidate = await fetch(`${origin}/api/${endpoint}`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/json', cookie },
          body: rpcBody(endpoint, args),
          signal: AbortSignal.timeout(10_000),
        })
        if (candidate.status === 503) {
          await delay(1_000)
          continue
        }
        response = candidate
        break
      } catch (error) {
        await delay(1_000)
        if (attempt === 119) throw error
      }
    }
    if (response === undefined) throw new Error(`${endpoint} never answered${unansweredDetail}`)
    if (!response.ok) throw new Error(`${endpoint} failed over HTTP ${String(response.status)}: ${await response.text()}`)
    const body = await response.json() as { result: RpcResult<T> }
    return body.result
  }

  async function remoteRpc<T>(origin: string, cookie: string, endpoint: string, args: object): Promise<T> {
    const result = await remoteRpcResult<T>(origin, cookie, endpoint, args)
    if (!result.ok) throw new Error(`${endpoint} failed: ${result.error.code}: ${result.error.message}`)
    return result.value
  }

  return { remoteRpc, remoteRpcResult }
}

export async function cookieHeader(context: BrowserContext, origin: string): Promise<string> {
  return (await context.cookies(origin)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}
