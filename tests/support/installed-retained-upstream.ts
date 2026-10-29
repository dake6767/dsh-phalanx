import { once } from 'node:events'
import { createServer } from 'node:http'
import { acceptanceProgress } from './acceptance-progress.js'
import { retainedPluginResult } from './installed-retained-contributions.js'
import { hasToolResult, latestHumanText, streamText, streamToolCall } from './real-dsh-model.js'

/** Controlled retained model/MCP upstream, kept alive across each saved upgrade step. */
export async function createRetainedUpgradeUpstream(input: {
  address: string
  catalogBytes: Uint8Array
  progress: Awaited<ReturnType<typeof acceptanceProgress>>
}) {
  const { address, catalogBytes, progress } = input
  const calls: Record<string, { failed: boolean; valid: boolean; tools: string[] }> = {}
  const pluginCalls: Record<string, { failed: boolean; valid: boolean }> = {}
  const state = { exposed: false }
  const fixture = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/catalog.json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(catalogBytes)
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405)
      response.end()
      return
    }
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    if (request.url === '/mcp') {
      if (request.headers.authorization !== 'Bearer fictional-upgrade-mcp-key') {
        response.writeHead(401)
        response.end()
        return
      }
      response.setHeader('content-type', 'application/json')
      if (body.id === undefined) {
        response.writeHead(202)
        response.end()
        return
      }
      const result =
        body.method === 'initialize'
          ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'upgrade-fixture', version: '1' } }
          : body.method === 'tools/list'
            ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'MANUAL_MCP_PRESERVED' }] }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      return
    }
    const marker = latestHumanText(body)
    state.exposed ||= text.includes('fictional-upgrade-mcp-key')
    response.setHeader('content-type', 'text/event-stream')
    if (marker.startsWith('RETAINED_PLUGIN_')) {
      const result = retainedPluginResult(body, marker)
      if (result) {
        pluginCalls[marker] = result
        streamText(response, 'RETAINED_PLUGIN_DONE')
      } else streamToolCall(response, marker, 'expert_fixture_remote', {})
      return
    }
    if (hasToolResult(body, marker, false) || hasToolResult(body, marker, true)) {
      calls[marker] = {
        failed: hasToolResult(body, marker, true),
        valid: text.includes('MANUAL_MCP_PRESERVED'),
        tools: (body.tools ?? [])
          .map((tool: { name: string }) => tool.name)
          .filter((name: string) => name.startsWith('mcp__'))
          .sort(),
      }
      streamText(response, 'UPGRADE_QUERY_DONE')
    } else streamToolCall(response, marker, 'mcp__p-selected__echo', {})
  })
  fixture.listen(progress.saved<{ port: number }>('fixture')?.port ?? 0, '0.0.0.0')
  await once(fixture, 'listening')
  await progress.step('fixture', async () => ({ port: (fixture.address() as { port: number }).port }))
  const upstream = `http://${address}:${(fixture.address() as { port: number }).port}`
  return { fixture, upstream, calls, pluginCalls, state }
}
