import { expect, it } from 'vitest'
import { inspectMcpRequest, filterMcpResponse, mcpCredentialTarget } from '../src/domain/mcp-protocol.js'
it('rejects disabled tool calls including batches and filters every list response while retaining pagination', () => {
  const blocked = ['write_file']
  expect(
    inspectMcpRequest({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'write_file', arguments: { secret: 'never-record' } } }, blocked),
  ).toMatchObject({ denied: true, methods: [{ method: 'tools/call', tool: 'write_file' }] })
  expect(
    inspectMcpRequest(
      [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_file' } },
      ],
      blocked,
    ).denied,
  ).toBe(true)
  const input = [{ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'write_file' }, { name: 'new_read' }], nextCursor: 'next' } }]
  expect(filterMcpResponse(input, blocked, '')).toEqual([{ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'new_read' }], nextCursor: 'next' } }])
  expect(inspectMcpRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'new_read' } }, blocked).denied).toBe(false)
})
it('keeps credential templates platform-side and masks secrets in structured upstream replies', () => {
  const target = mcpCredentialTarget({
    url: 'https://maps.example.test/mcp?region=cn&key=old',
    credential: 'test secret/+key',
    headers: [{ name: 'Authorization', value: 'Bearer {credential}' }],
    query: [{ name: 'key', value: '{credential}' }],
  })
  expect(new URL(target.baseUrl).searchParams.getAll('key')).toEqual(['test secret/+key'])
  expect(target.headers).toEqual([{ name: 'Authorization', value: 'Bearer test secret/+key' }])
  expect(target.credential).toBe('test secret/+key')
  expect(
    filterMcpResponse(
      { jsonrpc: '2.0', id: 1, result: { content: [{ text: 'test secret/+key' }, { text: encodeURIComponent('test secret/+key') }] } },
      [],
      'test secret/+key',
    ),
  ).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ text: '[redacted]' }, { text: '[redacted]' }] } })
})
it('rejects malformed RPC and does not retain parameters in the audit projection', () => {
  expect(() =>
    inspectMcpRequest(
      [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      ],
      [],
    ),
  ).toThrow()
  expect(() => inspectMcpRequest({ jsonrpc: '2.0', method: 'tools/call', params: {} }, [])).toThrow()
  const metadata = inspectMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: { personal: 'private' } } }, [])
  expect(JSON.stringify(metadata.methods)).not.toContain('private')
})
