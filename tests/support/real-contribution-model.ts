import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'

export interface ContributionModelObservation {
  readonly id: string
  readonly kind: string
  readonly codes: readonly string[]
  readonly isError: boolean
  readonly status?: string
}
/** Forward every byte to the real provider; observe only official user tool-result blocks. */
export async function startContributionModel(apiKey: string, observe?: (request: unknown, bytes: Buffer) => void) {
  const transfers: { status: number; contributionToolAvailable: boolean; toolCount: number }[] = []
  const observations: ContributionModelObservation[] = [],
    seen = new Set<string>(),
    active = new Set<AbortController>()
  const decode = (content: unknown): { codes: string[]; status?: string } => {
    const codes: string[] = []
    let status: string | undefined
    const visit = (value: unknown) => {
      if (typeof value === 'string') {
        try {
          visit(JSON.parse(value))
        } catch {
          /* Ordinary text is not a structured tool result. */
        }
        return
      }
      if (Array.isArray(value)) {
        value.forEach(visit)
        return
      }
      if (!value || typeof value !== 'object') return
      const row = value as Record<string, unknown>
      if (typeof row.code === 'string') codes.push(row.code)
      if (typeof row.status === 'string') status = row.status
      if (Array.isArray(row.findings)) row.findings.forEach(visit)
      if (row.type === 'text') visit(row.text)
      if (row.content !== undefined) visit(row.content)
    }
    visit(content)
    return { codes, ...(status ? { status } : {}) }
  }
  const server = createServer((request, response) => {
    const controller = new AbortController()
    active.add(controller)
    response.once('close', () => {
      if (!response.writableFinished) controller.abort()
    })
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks),
        body = JSON.parse(bytes.toString('utf8'))
      observe?.(body, bytes)
      const calls = new Map<string, string>()
      for (const message of body.messages ?? [])
        if (message.role === 'assistant' && Array.isArray(message.content))
          for (const block of message.content)
            if (block.type === 'tool_use' && block.name === 'submit_contribution' && block.input?.action === 'submit')
              calls.set(block.id, block.input.kind ?? 'skill')
      for (const message of body.messages ?? [])
        if (message.role === 'user' && Array.isArray(message.content))
          for (const block of message.content) {
            if (block.type !== 'tool_result' || !calls.has(block.tool_use_id) || seen.has(block.tool_use_id)) continue
            seen.add(block.tool_use_id)
            observations.push({ id: block.tool_use_id, kind: calls.get(block.tool_use_id)!, isError: block.is_error === true, ...decode(block.content) })
          }
      const transfer = {
        status: 0,
        contributionToolAvailable: (body.tools ?? []).some((tool: { name?: string }) => tool.name?.endsWith('submit_contribution')),
        toolCount: (body.tools ?? []).length,
      }
      transfers.push(transfer)
      const upstream = await fetch('https://api.deepseek.com' + (request.url ?? '/anthropic/v1/messages'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: bytes,
        signal: controller.signal,
      })
      transfer.status = upstream.status
      response.statusCode = upstream.status
      response.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json')
      if (upstream.body) for await (const chunk of upstream.body) if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal })
      response.end()
    })()
      .catch(() => response.destroy())
      .finally(() => active.delete(controller))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    observations,
    transfers,
    stop: async () => {
      for (const controller of active) controller.abort()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
