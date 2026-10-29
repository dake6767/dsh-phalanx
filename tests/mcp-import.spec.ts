import { expect, it } from 'vitest'
import { parseMcpServers } from '../src/domain/mcp-import.js'
import { validateMcpSettings } from '../src/domain/mcp-service.js'
import { mcpCredentialTarget, filterMcpResponse } from '../src/domain/mcp-protocol.js'

it('imports the five documented sample shapes without leaving their credentials in connection fields', () => {
  const rows = parseMcpServers(
    JSON.stringify({
      mcpServers: {
        context7: { url: 'https://mcp.context7.com/mcp' },
        github: { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer fictional-github-key' } },
        'amap-maps': { type: 'sse', url: 'https://mcp.amap.com/mcp?key=fictional-amap-key' },
        'bocha-search': {
          command: 'uv',
          args: ['--directory', '/path/to/bocha-search-mcp', 'run', 'bocha-search-mcp'],
          env: { BOCHA_API_KEY: 'fictional-bocha-key' },
        },
        playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
      },
    }),
  )
  expect(rows.map(row => row.input.name)).toEqual(['p-context7', 'p-github', 'p-amap-maps', 'p-bocha-search', 'p-playwright'])
  expect(rows[1]?.input.headers).toEqual([{ name: 'Authorization', value: 'Bearer {credential}' }])
  expect(rows[1]?.credentialSources).toEqual(['headers.Authorization'])
  expect(rows[2]?.input.url).not.toContain('fictional-amap-key')
  expect(rows[2]?.input.query).toEqual([{ name: 'key', value: '{credential}' }])
  expect(rows[3]?.input.run).toMatchObject({ location: 'shared', env: [{ name: 'BOCHA_API_KEY', value: '{credential}' }] })
  expect(rows[4]?.input.run?.location).toBe('shared')
  for (const row of rows) validateMcpSettings(row.input)
})
it('preserves multiple distinct credentials, templates and ordinary values for confirmation', () => {
  const [row] = parseMcpServers(
    JSON.stringify({
      mcpServers: {
        service: {
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer fictional-first', 'X-Api-Key': 'fictional-second', 'X-Mode': 'read', 'X-Other': 'ghp_abcdefghijklmnopqrstuvwx' },
        },
      },
    }),
  )
  expect(row!.input.credential).toBe('fictional-first')
  expect(Object.values(row!.input.credentials!)).toEqual(['fictional-second', 'ghp_abcdefghijklmnopqrstuvwx'])
  const target = mcpCredentialTarget(row!.input)
  expect(target.headers).toContainEqual({ name: 'X-Api-Key', value: 'fictional-second' })
  expect(target.headers).toContainEqual({ name: 'X-Mode', value: 'read' })
  expect(filterMcpResponse('fictional-first fictional-second', [], ['fictional-first', 'fictional-second'])).toBe('[redacted] [redacted]')
  expect(() => validateMcpSettings({ ...row!.input, run: { location: 'member', command: 'node', args: [], env: [], prepareCommand: '' } })).toThrow()
})
it('rejects invalid JSON, unknown or contradictory fields and reports paths without echoing their values', () => {
  for (const value of [
    '{secret',
    '{}',
    '{"mcpServers":[]}',
    '{"mcpServers":{}}',
    '{"mcpServers":{"x":{"url":"https://example.test","unknown":"never-echo"}}}',
    '{"mcpServers":{"x":{"url":"https://example.test","command":"node"}}}',
    '{"mcpServers":{"x":{"command":"node","args":[4]}}}',
  ]) {
    expect(() => parseMcpServers(value)).toThrow()
    try {
      parseMcpServers(value)
    } catch (error) {
      expect(String(error)).not.toContain('never-echo')
    }
  }
  expect(() => parseMcpServers('{"mcpServers":{"x":{"url":"https://example.test","mystery":true}}}')).toThrow('mcpServers.x.mystery')
  expect(() => parseMcpServers('{"mcpServers":{"x":{"url":"https://example.test","type":"stdio"}}}')).toThrow()
})
it('masks overlapping current and rotated credential values without leaving suffixes', () => {
  const secrets = ['fictional-prefix', 'fictional-prefix-remaining-secret', 'encoded/+secret']
  expect(filterMcpResponse({ result: { text: 'fictional-prefix-remaining-secret encoded%2F%2Bsecret' } }, [], secrets)).toEqual({
    result: { text: '[redacted] [redacted]' },
  })
})
