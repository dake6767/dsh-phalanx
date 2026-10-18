import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { suiteRuntimeDependencyDefinition, type SuiteCatalogExecutionItem, type SuiteCatalogRuntimeDependencyItem, type SuiteCatalogSkillItem, type SuiteCatalogSkillPackItem, type SuiteCatalogSuiteEntry } from '../src/domain/suite-catalog.js'
import { validatedAdapters, documentEntry, fixtureEntry, writeGeneratedWrapper } from './fixtures/suite-catalog-converted.js'

const lark = fixtureEntry('lark') as SuiteCatalogSuiteEntry
const tool = lark.items.find((item): item is SuiteCatalogRuntimeDependencyItem => item.kind === 'runtime-dependency')!
const roots: string[] = []
const exec = promisify(execFile)

/** Runs a generated wrapper asynchronously so the in-process HTTP fixture can answer. */
async function runWrapper(wrapper: string, args: readonly string[], environment: Readonly<Record<string, string>> = {}): Promise<{ readonly status: number, readonly stdout: string, readonly stderr: string }> {
  try {
    const result = await exec(wrapper, [...args], { encoding: 'utf8', env: { ...process.env, ...environment } })
    return { status: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { code?: number, stdout?: string, stderr?: string }
    return { status: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('ships Feishu as a bot-identity suite with blocked identity commands and two app credentials', () => {
  expect(lark.items.map(item => item.kind)).toEqual(['runtime-dependency', 'skill', 'execution', 'skill-pack'])
  const execution = lark.items.find((item): item is SuiteCatalogExecutionItem => item.kind === 'execution')!
  expect(execution).toMatchObject({ skill: 'lark-shared', runtimeDependency: 'feishu-tools', delegated: [{ command: 'lark-cli', blocked: ['config', 'auth', 'profile', 'update'] }] })
  expect(execution.variables.map(row => row.name)).toEqual(['LARKSUITE_CLI_APP_ID', 'LARKSUITE_CLI_APP_SECRET'])
  // Personal identity is out of scope for this version; the identity text says so.
  expect(lark.identity.en).toContain('--as user')
  expect(lark.identity['zh-CN']).toContain('--as user')
  expect(lark.serviceAddresses).toEqual(['https://open.feishu.cn'])
})

it('declares the token exchange and bot environment as data, with every runtime address declared', () => {
  const document = documentEntry('lark')
  if (document.kind !== 'suite') throw new Error('unexpected kind')
  expect(document.serviceAddresses).toEqual(['https://open.feishu.cn'])
  expect(document.adapters).toEqual([
    { name: 'credential-token', params: {
      item: 'feishu-tools', command: 'lark-cli',
      request: { url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', method: 'POST', headers: { 'content-type': 'application/json' },
        body: { app_id: { env: 'LARKSUITE_CLI_APP_ID' }, app_secret: { env: 'LARKSUITE_CLI_APP_SECRET' } } },
      responseTokenPath: 'tenant_access_token', environment: 'LARKSUITE_CLI_TENANT_ACCESS_TOKEN', message: 'Bot credentials could not be used.' } },
    { name: 'fixed-environment', params: { item: 'feishu-tools', command: 'lark-cli', environment: { LARKSUITE_CLI_BRAND: 'feishu', LARKSUITE_CLI_DEFAULT_AS: 'bot',
      LARKSUITE_CLI_STRICT_MODE: 'bot', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } } },
  ])
  expect(validatedAdapters('lark', 'feishu-tools')).toMatchObject([
    { kind: 'credential-token', credentialVariables: ['LARKSUITE_CLI_APP_ID', 'LARKSUITE_CLI_APP_SECRET'], responseTokenPath: ['tenant_access_token'] },
    { kind: 'fixed-environment' },
  ])
})

it('generates the accepted 0.1.15 bot wrapper behavior: token in the isolated process, bot environment, forwarded arguments', async () => {
  for (const [architecture, asset, sha] of [['amd64', 'amd64', '4a12dcb7a0aab25986d8bcd046cb45b08278531a9aac3a12b53cf3d94738fe80'], ['arm64', 'arm64', 'f798b26ce4b369d70411945e7f66bbe4382c411bc47d81950a662de7b69b41ed']] as const) {
    const command = suiteRuntimeDependencyDefinition(tool, architecture)!.prepareCommand
    expect(command).toContain(`\${GITHUB_ASSETS_PREFIX}https://github.com/larksuite/cli/releases/download/v1.0.98/lark-cli-1.0.98-linux-${asset}.tar.gz`)
    expect(command).toContain(`echo "${sha}  lark.tgz" | sha256sum -c -`)
    expect(command).toContain('tar xzf lark.tgz -C lib')
    expect(command).toContain('.platform-token-lark-cli.mjs')
    expect(command).toContain('LARKSUITE_CLI_TENANT_ACCESS_TOKEN')
    expect(command).toContain('LARKSUITE_CLI_DEFAULT_AS=bot')
    expect(command).toContain('LARKSUITE_CLI_STRICT_MODE=bot')
  }
  expect(tool).toMatchObject({ name: 'feishu-tools', pathDirectories: ['bin'], checkCommand: 'lark-cli --version', commands: ['lark-cli'] })
  const skills = lark.items.find((item): item is SuiteCatalogSkillItem => item.kind === 'skill')!
  expect(skills.source).toEqual({ type: 'git', url: 'https://github.com/larksuite/cli', commit: 'ac81f5056ab88f37d581d25916f3dab85abfca76', path: 'skills' })
  expect(skills.names).toHaveLength(28)
  // Delegation alone provides lark-cli; the skills declare no runtime dependency of their own.
  expect(skills.runtimeDependency).toBeUndefined()
  const pack = lark.items.find((item): item is SuiteCatalogSkillPackItem => item.kind === 'skill-pack')!
  expect(pack).toMatchObject({ name: 'lark', skills: skills.names })
  expect(pack.note).toContain('personal identity (`--as user`) is not available')
})

async function tokenService(): Promise<{ url: string, requests: { body: string, headers: Record<string, string | string[] | undefined> }[], respond(status: number, payload: string): void, close(): Promise<void> }> {
  const requests: { body: string, headers: Record<string, string | string[] | undefined> }[] = []
  let reply = { status: 200, payload: JSON.stringify({ code: 0, tenant_access_token: 'tenant-token-fixture' }) }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({ body: Buffer.concat(chunks).toString('utf8'), headers: request.headers })
      response.writeHead(reply.status, { 'content-type': 'application/json' })
      response.end(reply.payload)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('token fixture did not listen')
  return { url: `http://127.0.0.1:${address.port}/open-apis/auth/v3/tenant_access_token/internal`, requests,
    respond: (status, payload) => { reply = { status, payload } },
    close: async () => { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) } }
}

/** Writes the generated wrapper with the token URL pointed at the local fixture (the declaration is rewritten too). */
async function preparedLark(tokenOrigin?: string): Promise<{ root: string, wrapper: string, cli: string }> {
  const root = await mkdtemp(join(tmpdir(), 'lark-wrapper-')); roots.push(root)
  await mkdir(join(root, 'lib'), { recursive: true })
  const wrapper = await writeGeneratedWrapper(root, 'lark', 'feishu-tools', 'lark-cli')
  if (tokenOrigin) {
    // The adapter data is what the catalog publishes; the test points the same request origin at its local fixture.
    const helper = join(root, 'bin/.platform-token-lark-cli.mjs')
    const source = await readFile(helper, 'utf8')
    await writeFile(helper, source.replace('https://open.feishu.cn', tokenOrigin))
    expect(await readFile(helper, 'utf8')).toContain(tokenOrigin)
  }
  const cli = join(root, 'lib/lark-cli')
  await writeFile(cli, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), token: process.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN ?? null, brand: process.env.LARKSUITE_CLI_BRAND ?? null, as: process.env.LARKSUITE_CLI_DEFAULT_AS ?? null, strict: process.env.LARKSUITE_CLI_STRICT_MODE ?? null, noUpdate: process.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER ?? null }))\n', { mode: 0o755 })
  await chmod(cli, 0o755)
  return { root, wrapper: wrapper.path, cli }
}

it('exchanges the app credentials for a tenant token through a local HTTP fixture and forwards the bot environment', async () => {
  const service = await tokenService()
  try {
    const { wrapper } = await preparedLark(new URL(service.url).origin)
    const result = await runWrapper(wrapper, ['docs', 'list', '--as', 'bot'], { LARKSUITE_CLI_APP_ID: 'app-id-fixture', LARKSUITE_CLI_APP_SECRET: 'app-secret-fixture' })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ argv: ['docs', 'list', '--as', 'bot'], token: 'tenant-token-fixture', brand: 'feishu', as: 'bot', strict: 'bot', noUpdate: '1' })
    expect(service.requests).toHaveLength(1)
    expect(JSON.parse(service.requests[0]!.body)).toEqual({ app_id: 'app-id-fixture', app_secret: 'app-secret-fixture' })
    expect(service.requests[0]!.headers['content-type']).toContain('application/json')
    // Credential values never appear in the generated wrapper or helper.
    for (const file of [wrapper, join(wrapper, '..', '.platform-token-lark-cli.mjs')]) {
      const text = await readFile(file, 'utf8')
      expect(text).not.toContain('app-secret-fixture')
      expect(text).not.toContain('tenant-token-fixture')
    }
  } finally { await service.close() }
})

it('skips the exchange without credentials and reports a failed exchange without running the CLI', async () => {
  const service = await tokenService()
  try {
    const { wrapper } = await preparedLark(new URL(service.url).origin)
    const withoutCredentials = await runWrapper(wrapper, ['docs', 'list'])
    expect(withoutCredentials.status).toBe(0)
    expect(JSON.parse(withoutCredentials.stdout)).toMatchObject({ token: null, brand: 'feishu', as: 'bot' })
    expect(service.requests).toHaveLength(0)

    service.respond(500, JSON.stringify({ code: 99, msg: 'denied' }))
    const failed = await runWrapper(wrapper, ['docs', 'list'], { LARKSUITE_CLI_APP_ID: 'id', LARKSUITE_CLI_APP_SECRET: 'secret' })
    expect(failed.status).toBe(1)
    expect(failed.stdout).toBe('')
    expect(failed.stderr).toContain('Bot credentials could not be used.')
  } finally { await service.close() }
})
