import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client'

/** Member-side transport for the platform's shared MCP gateway. */
export function sharedMcpTransport(create: () => Transport, expired: (error: unknown) => boolean,
  observe: (event: 'session-expired' | 'recovery-succeeded' | 'recovery-failed' | 'recovery-timeout') => void = () => {}): Transport {
  let current: Transport | undefined, initialize: JSONRPCMessage | undefined, recovery: Promise<void> | undefined
  let closed = false, protocol: string | undefined
  let recoveryAbort: AbortController | undefined
  const pending = new Map<string | number, { owner: Transport, concluded: boolean }>()
  const deliver = (next: Transport, message: JSONRPCMessage) => {
    if (current !== next) return
    if ('id' in message && message.id !== undefined && !('method' in message)) {
      const entry = pending.get(message.id)
      if (entry) entry.concluded = true
      pending.delete(message.id)
    }
    transport.onmessage?.(message)
  }
  const lost = (next: Transport, id: string | number) => {
    const entry = pending.get(id)
    if (entry?.owner !== next) return
    entry.concluded = true
    pending.delete(id)
    transport.onmessage?.({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Shared MCP: unknown-result. Do not automatically repeat the call.' } })
  }
  const attach = () => {
    const next = create()
    next.onmessage = message => deliver(next, message)
    next.onclose = () => { for (const [id, entry] of pending) if (entry.owner === next) lost(next, id) }
    // A failed GET subscription must not restart an idle carrier by itself.
    next.onerror = () => {}
    return next
  }
  const recover = (previous: Transport | undefined): Promise<void> => {
    if (recovery) return recovery
    if (current !== previous) return Promise.resolve()
    recovery = (async () => {
      await previous?.close()
      if (closed || !initialize) throw new Error('Shared MCP connection is unavailable')
      const next = attach(); current = next
      const abort = new AbortController(); recoveryAbort = abort
      const id = crypto.randomUUID()
      let complete!: () => void, failed!: (error: Error) => void
      const ready = new Promise<void>((resolve, reject) => { complete = resolve; failed = reject })
      let timedOut = false
      const interrupted = new Promise<never>((_resolve, reject) => abort.signal.addEventListener('abort', () => reject(new Error(timedOut ? 'Shared MCP recovery-timeout' : 'Shared MCP recovery cancelled')), { once: true }))
      const timer = setTimeout(() => { timedOut = true; abort.abort() }, 30_000)
      next.onmessage = message => {
        if (current !== next) return
        if ('id' in message && message.id === id && !('method' in message)) {
          if ('result' in message) complete()
          else failed(new Error('Shared MCP initialization failed'))
        } else deliver(next, message)
      }
      try {
        await Promise.race([interrupted, (async () => {
          await next.start()
          await Promise.all([next.send({ ...initialize, id } as JSONRPCMessage, { requestSignal: abort.signal }), ready])
          if (protocol) next.setProtocolVersion?.(protocol)
          await next.send({ jsonrpc: '2.0', method: 'notifications/initialized' }, { requestSignal: abort.signal })
        })()])
        observe('recovery-succeeded')
      } catch (error) {
        const reason = timedOut ? 'recovery-timeout' : 'initialization-rejected'
        observe(timedOut ? 'recovery-timeout' : 'recovery-failed')
        await next.close(); current = undefined
        throw Object.assign(new Error('Shared MCP ' + reason), { reason, cause: error })
      }
      finally { clearTimeout(timer); recoveryAbort = undefined }
    })().finally(() => { recovery = undefined })
    return recovery
  }
  const transport: Transport = {
    async start() { current = attach(); await current.start() },
    async send(message, options) {
      if (closed) throw new Error('Shared MCP connection is closed')
      if ('method' in message && message.method === 'initialize') initialize = message
      await recovery
      options?.requestSignal?.throwIfAborted()
      if (!current && initialize) await recover(undefined)
      const target = current
      if (!target) throw new Error('Shared MCP connection is unavailable')
      const id = 'method' in message && 'id' in message ? message.id : undefined
      const send = async (next: Transport) => {
        const entry = { owner: next, concluded: false }
        if (id !== undefined) {
          pending.set(id, entry)
          options?.requestSignal?.addEventListener('abort', () => { entry.concluded = true; if (pending.get(id) === entry) pending.delete(id) }, { once: true })
        }
        try { await next.send(message, { ...options, onRequestStreamEnd: () => { if (id !== undefined) lost(next, id); options?.onRequestStreamEnd?.() } }) }
        catch (error) {
          if (id !== undefined && pending.get(id) === entry) pending.delete(id)
          // Closing an old connection may already have reported this concurrent
          // request as unknown. A late HTTP error cannot authorize a new send.
          if (!entry.concluded) throw error
        }
      }
      try { await send(target) }
      catch (error) {
        if (!initialize || !expired(error) || !('method' in message) || !('id' in message) || message.method === 'initialize') throw error
        // HTTP 404 from the private bridge rejects before dispatch: only this
        // known-unexecuted request may be sent once after reinitialization.
        observe('session-expired')
        await recover(target)
        options?.requestSignal?.throwIfAborted()
        if (closed || !current) throw new Error('Shared MCP connection is unavailable')
        await send(current)
      }
    },
    setProtocolVersion(value) { protocol = value; current?.setProtocolVersion?.(value) },
    async close() { closed = true; recoveryAbort?.abort(); await current?.close(); transport.onclose?.() },
  }
  return transport
}
