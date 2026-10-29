import { expect, it } from 'vitest'
import { parseCommunityCommand } from '../src/inbound/community-command.js'
it('parses installer initialization paths and a valid loopback database port before service construction', () => {
  expect(
    parseCommunityCommand([
      'database-initialize',
      '--config-file',
      '/private/database.json',
      '--master-key-file',
      '/private/master.key',
      '--data-root',
      '/private/data',
      '--port',
      '25432',
    ]),
  ).toEqual({ kind: 'database-initialize', configFile: '/private/database.json', masterKeyPath: '/private/master.key', dataRoot: '/private/data', port: 25432 })
})
it('parses user-unit password-file and readiness operations without accepting secret values', () => {
  expect(
    parseCommunityCommand([
      'database-password-file',
      '--config-file',
      '/private/database.json',
      '--data-root',
      '/private/data',
      '--output',
      '/run/user/1000/database/password',
    ]),
  ).toEqual({ kind: 'database-password-file', configFile: '/private/database.json', dataRoot: '/private/data', output: '/run/user/1000/database/password' })
  expect(parseCommunityCommand(['database-wait', '--config-file', '/private/database.json', '--data-root', '/private/data'])).toEqual({
    kind: 'database-wait',
    configFile: '/private/database.json',
    dataRoot: '/private/data',
  })
  expect(() => parseCommunityCommand(['database-initialize', '--password', 'fictional'])).toThrow()
  expect(() => parseCommunityCommand(['database-initialize', '--config-file', 'x', '--master-key-file', 'x', '--data-root', 'x', '--port', '65536'])).toThrow()
})
