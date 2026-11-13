import { expect, it } from 'vitest'
import { planNativeDependencyCommands } from '../src/use-cases/member-native-dependency-plan.js'

it('exposes only claimed locked plugin commands and isolates cross-plugin basename conflicts', () => {
  const version = (name: string) => ({
    id: name,
    identity: name,
    directory: '/host/' + name,
    mountedPath: '/fixed/' + name,
    pathDirectories: [],
    commands: [],
    commandPaths: {},
    bytes: 1,
    isolated: true,
    checks: [],
    log: '',
  })
  const binding = (dependency: string, commands: readonly string[]) => ({
    dependencies: [dependency],
    resources: [
      { kind: 'command-path' as const, dependency, runtimeDependency: dependency, version: '1.0.0', contentHash: 'a'.repeat(64), path: 'bin', commands },
    ],
  })
  const ready = (names: readonly string[]) => names.map(version)
  const one = binding('scope', ['ffmpeg'])
  const both = planNativeDependencyCommands({ plugin: one, sibling: one }, new Map(), ready)
  expect(both.blocked).toEqual([])
  expect(both.bindings.get('scope')?.nativeCommandPaths).toEqual({ ffmpeg: 'bin/ffmpeg' })
  const conflict = planNativeDependencyCommands({ plugin: one, sibling: binding('other', ['ffmpeg']), third: binding('tools', ['python3']) }, new Map(), ready)
  expect(conflict.blocked.sort()).toEqual(['plugin', 'sibling'])
  expect([...conflict.bindings.keys()]).toEqual(['tools'])
  const global = { ...version('global'), commands: ['ffmpeg'], commandPaths: { ffmpeg: 'bin/ffmpeg' } }
  const member = planNativeDependencyCommands({ plugin: one }, new Map([['global', global]]), ready)
  expect(member.blocked).toEqual(['plugin'])
  expect([...member.bindings.values()]).toEqual([global])
  const mcp = planNativeDependencyCommands({ plugin: one }, new Map(), ready, [global])
  expect(mcp.blocked).toEqual(['plugin'])
})
