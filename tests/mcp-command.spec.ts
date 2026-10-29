import { expect, it } from 'vitest'
import { posix } from 'node:path'
import { preparedMcpCommand } from '../src/domain/mcp-command.js'

it('resolves new bare MCP commands through declared PATH and limits private directory lookup to compatibility entries', () => {
  const system = {
    node: '/usr/bin/node',
    read: () => '',
    exists: (path: string) => path === '/dependency-a/node_modules/.bin/tool',
    join: posix.join,
    resolve: posix.resolve,
  }
  const config = { directory: '/dependency-a', command: 'tool', args: [] }
  expect(preparedMcpCommand(config, system)).toEqual({ command: 'tool', args: [] })
  expect(preparedMcpCommand({ ...config, compatibility: true }, system).command).toBe('/dependency-a/node_modules/.bin/tool')
})
