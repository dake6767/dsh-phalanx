import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { dumpNativeConfiguration } from '../src/adapters/native-config-dump.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'

it('accepts successful configuration output after the transient container has auto-removed, but propagates other cleanup failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-config-dump-'))
  const cli = join(root, 'container-cli'),
    log = join(root, 'operations.jsonl'),
    cleanupFailure = join(root, 'cleanup-failure')
  await writeFile(
    cli,
    `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]==='run'){process.stdout.write('- id: fixture\\n  config: { value: private-fixture-value }\\n');}
else if(args[0]==='rm'){if(fs.existsSync(${JSON.stringify(cleanupFailure)})||!args.includes('--ignore'))process.exitCode=1;}
else process.exitCode=2;
`,
    { mode: 0o700 },
  )
  const config: CommunityRuntimeConfig = {
    command: 'node',
    args: ['/fixture/official-cli', '--profile', 'web'],
    dataRoot: root,
    defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
    container: { runtime: cli, image: 'fixture', internalPort: 4180, gatewayPort: 3081 },
  }
  const input = {
    config,
    workspace: root,
    environment: {},
    patches: ['/fixture/overlay.yml'],
    container: {
      config,
      userId: 'member',
      spaceId: 'space',
      hostname: 'fixture-member',
      runtimeHome: root,
      workspace: root,
      publicAuthority: 'example.test',
      ownership: 'fixture-owned',
      gatewayUrl: 'http://127.0.0.1:3081',
      environment: {},
    },
  }
  try {
    expect(await dumpNativeConfiguration(input, new AbortController().signal)).toContain('private-fixture-value')
    const operations = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map(row => JSON.parse(row) as string[])
    expect(operations).toHaveLength(2)
    expect(operations[0]).toContain('--rm')
    expect(operations[1]!.slice(0, 3)).toEqual(['rm', '--force', '--ignore'])
    await writeFile(cleanupFailure, '')
    await expect(dumpNativeConfiguration(input, new AbortController().signal)).rejects.toThrow('cleanup failed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('runs the host export with its real working directory and does not report private command output on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-config-host-'))
  const script = join(root, 'dump.cjs')
  const config: CommunityRuntimeConfig = {
    command: process.execPath,
    args: [script],
    dataRoot: root,
    defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
  }
  try {
    await writeFile(script, `process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))`)
    const output = await dumpNativeConfiguration({ config, workspace: root, environment: {}, patches: ['first.yml', 'last.yml'] }, new AbortController().signal)
    expect(JSON.parse(output)).toEqual({
      cwd: await import('node:fs/promises').then(fs => fs.realpath(root)),
      args: ['--patch', 'first.yml', '--patch', 'last.yml', '--dump-config'],
    })
    await writeFile(script, `process.stderr.write('PRIVATE_MEMBER_SETTING');process.stdout.write('PRIVATE_MEMBER_SETTING');process.exitCode=1`)
    await expect(dumpNativeConfiguration({ config, workspace: root, environment: {}, patches: [] }, new AbortController().signal)).rejects.toThrow(
      /^Native configuration preparation failed$/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
