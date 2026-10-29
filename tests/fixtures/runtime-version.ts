import type { RuntimeDependencyVersion } from '../../src/domain/runtime-dependency.js'

export const runtimeVersion = (character: string, identity = character): RuntimeDependencyVersion => ({
  id: character.repeat(64),
  identity,
  directory: '/prepared/' + character,
  mountedPath: '/runtime/' + character,
  pathDirectories: ['bin'],
  commands: ['tool'],
  commandPaths: { tool: 'bin/tool' },
  bytes: 1,
  isolated: true,
  checks: [],
  log: 'prepared',
})
