import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { CommunityMcpTool } from '../domain/admin-contract.js'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { McpService } from '../domain/mcp-service.js'
import { McpProtocolError, mcpRecord } from '../domain/mcp-protocol.js'
import type { McpProbePort } from '../ports/mcp-services.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import type { CommunityUserSpaceStoragePort } from '../ports/community-user-spaces.js'
import { memberMcpInvocation } from '../dsh/member-mcp.js'
import { discoverMcpTools } from './mcp-discovery.js'
import { containerClientEnvironment } from './runtime-command.js'

/** Diagnostics run the same frozen wrapper inside the administrator's member environment. */
export class MemberMcpProbe implements McpProbePort {
  private stopped = false
  private readonly active = new Set<Promise<readonly CommunityMcpTool[]>>()
  private readonly shutdown = new AbortController()
  constructor(private readonly config: CommunityRuntimeConfig, private readonly lookup: (username: string, name: string) => McpService,
    private readonly ensure: (username: string) => Promise<CommunityUserInstance>, private readonly spaces: CommunityUserSpaceStoragePort) {}
  probe(username: string, _spaceId: string, name: string): Promise<readonly CommunityMcpTool[]> {
    if (this.stopped) return Promise.reject(new McpProtocolError('MCP diagnostics stopped'))
    const task = this.run(username, name); this.active.add(task)
    void task.finally(() => this.active.delete(task)).catch(() => {}); return task
  }
  async stop(): Promise<void> { this.stopped = true; this.shutdown.abort(); await Promise.allSettled(this.active) }
  private async run(username: string, name: string): Promise<readonly CommunityMcpTool[]> {
    const instance = await this.ensure(username), space = await this.spaces.prepare(username)
    this.shutdown.signal.throwIfAborted()
    const invocation = memberMcpInvocation(this.lookup(username, name), true)
    const command = this.config.container?.runtime ?? process.execPath
    if (this.config.container && !instance.containerName) throw new McpProtocolError('Member container is unavailable')
    const args = this.config.container ? ['exec', '-i', instance.containerName!, invocation.command, ...invocation.args] : invocation.args
    const child = spawn(command, args, { cwd: space.workspace, env: this.config.container ? containerClientEnvironment() : { ...process.env, HOME: space.home }, stdio: ['pipe', 'pipe', 'pipe'] })
    let id = 0, failure: unknown
    const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void, reject: (error: unknown) => void }>()
    const fail = (error: unknown) => { failure = error; for (const task of pending.values()) task.reject(error); pending.clear() }
    const exit = new Promise<void>(resolve => { child.once('close', () => { fail(new McpProtocolError('MCP process ended')); resolve() }); child.once('error', error => { fail(error); resolve() }) })
    const abort = () => { fail(new McpProtocolError('MCP diagnostic stopped')); child.stdin.end() }
    const timer = setTimeout(abort, 30_000); this.shutdown.signal.addEventListener('abort', abort, { once: true })
    child.stdin.on('error', fail); child.stderr.resume()
    const read = (async () => {
      const decoder = new StringDecoder('utf8'); let buffer = ''
      for await (const chunk of child.stdout) {
        buffer += decoder.write(chunk as Buffer)
        if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) throw new McpProtocolError('MCP response exceeds limit')
        let end: number
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue
          const row: unknown = JSON.parse(line)
          if (!mcpRecord(row) || row.jsonrpc !== '2.0') throw new McpProtocolError('Invalid MCP response')
          if (typeof row.method === 'string') {
            if (row.id !== undefined) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: row.id, ...(row.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Unsupported diagnostic request' } }) }) + '\n')
            continue
          }
          const target = typeof row.id === 'number' ? pending.get(row.id) : undefined
          if (!target) continue
          pending.delete(row.id as number)
          if (row.error || !mcpRecord(row.result)) target.reject(new McpProtocolError('MCP diagnostic failed'))
          else target.resolve(row.result)
        }
      }
    })().catch(error => { fail(error); abort() })
    const send = async (method: string, params?: unknown, notification = false): Promise<Record<string, unknown>> => {
      if (failure) throw failure
      const requestId = ++id
      const response = notification ? Promise.resolve({}) : new Promise<Record<string, unknown>>((resolve, reject) => pending.set(requestId, { resolve, reject }))
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id: requestId } : {}), method, ...(params ? { params } : {}) }) + '\n')
      return response
    }
    try { return await discoverMcpTools(send) }
    finally {
      clearTimeout(timer); this.shutdown.signal.removeEventListener('abort', abort)
      child.stdin.end()
      // The wrapper needs up to 2 seconds after EOF to reap its entire process group.
      const kill = setTimeout(() => child.kill('SIGKILL'), 6000)
      await Promise.allSettled([exit, read]); clearTimeout(kill)
    }
  }
}
