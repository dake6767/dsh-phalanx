import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { auditArchitectureAssets, countCssCodeLines, countJsCodeLines } from '../scripts/check-architecture-assets.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const lint = async (file: string, source: string): Promise<string[]> => {
  const [result] = await new ESLint({ cwd: ROOT }).lintText(source, { filePath: `${ROOT}${file}` })
  return (result?.messages ?? []).filter(message => message.severity === 2)
    .map(message => message.ruleId ?? 'fatal').filter(rule => rule.startsWith('dsh-phalanx/'))
}

describe('architecture machine gates', () => {
  it('rejects cross-layer imports and lets a use case depend on its ports', async () => {
    expect(await lint('src/use-cases/community-instance-lifecycle.ts', "import type { CommunityRuntimePort } from '../ports/community-runtime.js'\nexport type Probe = CommunityRuntimePort"))
      .toEqual([])
    expect(await lint('src/use-cases/community-instance-lifecycle.ts', "import type { CommunityAccountStore } from '../adapters/community-account-store.js'\nexport type Probe = CommunityAccountStore"))
      .toContain('dsh-phalanx/layer')
    expect(await lint('src/use-cases/community-instance-lifecycle.ts', "export const probe = async () => await import('node:fs')"))
      .toContain('dsh-phalanx/layer')
    expect(await lint('src/domain/community-account.ts', "import '../../scripts/fast-check.mjs'"))
      .toContain('dsh-phalanx/layer')
    expect(await lint('src/domain/community-account.ts', "export const probe = () => process['getBuiltinModule']('node:fs')"))
      .toContain('dsh-phalanx/layer')
    expect(await lint('src/domain/community-account.ts', "export const probe = () => globalThis['fetch']('https://example.test')"))
      .toContain('dsh-phalanx/layer')
  })

  it('requires every control-plane source file to be in a known layer', async () => {
    expect(await lint('src/orphan.ts', 'export const probe = 1')).toContain('dsh-phalanx/layer')
    expect(await lint('src/domain/community-account.ts', 'export const probe = 1')).toEqual([])
  })

  it('rejects infrastructure calls in domain/use cases but allows adapter I/O', async () => {
    expect(await lint('src/domain/community-account.ts', "export const probe = () => fetch('https://example.test')"))
      .toContain('dsh-phalanx/layer')
    expect(await lint('src/adapters/community-account-store.ts', "import { readFileSync } from 'node:fs'\nexport const probe = () => readFileSync('/tmp/probe')"))
      .toEqual([])
  })

  it('rejects error-message branching while permitting typed error branching', async () => {
    expect(await lint('src/domain/community-account.ts', "export const probe = (error: Error) => error.message === 'stopped' ? 1 : 0"))
      .toContain('dsh-phalanx/error-message-branch')
    expect(await lint('src/domain/community-account.ts', "export const probe = (error: Error) => error instanceof RangeError ? 1 : 0"))
      .toEqual([])
    expect(await lint('src/domain/community-account.ts', "export const probe = (state: { failure: string }) => state.failure === 'stopped' ? 1 : 0"))
      .toContain('dsh-phalanx/error-message-branch')
    expect(await lint('src/domain/community-account.ts', "export const probe = (error: Error) => error['message'] === 'stopped' ? 1 : 0"))
      .toContain('dsh-phalanx/error-message-branch')
    expect(await lint('src/domain/community-account.ts', "export const probe = (error: Error) => { const reason = error.message; return reason === 'stopped' ? 1 : 0 }"))
      .toContain('dsh-phalanx/error-message-branch')
  })

  it('keeps DSH protocol constants in the seam layer', async () => {
    expect(await lint('src/inbound/platform-session.ts', "export const endpoint = '/api/remote.mux'"))
      .toContain('dsh-phalanx/dsh-seam')
    expect(await lint('src/dsh/container.ts', "export const endpoint = '/api/remote.mux'"))
      .toEqual([])
    expect(await lint('src/inbound/platform-session.ts', 'export const endpoint = `/api/${"remote.mux"}`'))
      .toContain('dsh-phalanx/dsh-seam')
    expect(await lint('src/inbound/platform-session.ts', "export const endpoint = 'pluginManager/getInstalled'"))
      .toContain('dsh-phalanx/dsh-seam')
    expect(await lint('src/domain/community-account.ts', "export const event = 'llm/stream'"))
      .toContain('dsh-phalanx/dsh-seam')
    expect(await lint('src/dsh/community-profile.ts', "export const event = 'llm/stream'"))
      .toEqual([])
  })

  it('rejects named plugin and service branches while accepting generic row matching', async () => {
    expect(await lint('src/inbound/plugin-proxy.ts', "export const probe = (pluginId: string) => pluginId === 'firecrawl'"))
      .toContain('dsh-phalanx/plugin-special-case')
    expect(await lint('src/inbound/plugin-proxy.ts', "export const probe = (serviceName: string) => { switch (serviceName) { case 'Tavily': return 1; default: return 0 } }"))
      .toContain('dsh-phalanx/plugin-special-case')
    expect(await lint('src/inbound/plugin-proxy.ts', "export const probe = (plugin: { id: string }) => plugin.id === 'firecrawl'"))
      .toContain('dsh-phalanx/plugin-special-case')
    expect(await lint('src/inbound/plugin-proxy.ts', "export const probe = (service: { name: string }) => service.name === 'Tavily'"))
      .toContain('dsh-phalanx/plugin-special-case')
    expect(await lint('src/inbound/plugin-proxy.ts', "export const probe = (pluginId: string, row: { pluginId: string }) => row.pluginId === pluginId"))
      .toEqual([])
  })

  it('keeps file, SQLite and container I/O in adapters', async () => {
    expect(await lint('src/inbound/platform-session.ts', "import { readFileSync } from 'node:fs'\nexport const probe = readFileSync"))
      .toContain('dsh-phalanx/io-exit')
    expect(await lint('src/adapters/community-account-store.ts', "import { readFileSync } from 'node:fs'\nexport const probe = readFileSync"))
      .toEqual([])
    expect(await lint('src/inbound/platform-session.ts', "export const probe = () => process['getBuiltinModule']('node:fs')"))
      .toContain('dsh-phalanx/io-exit')
  })

  it('requires browser management responses to use the shared contract', async () => {
    expect(await lint('admin-ui/src/community-api.ts', 'export interface NewResponse { enabled: boolean }'))
      .toContain('dsh-phalanx/admin-contract')
    expect(await lint('admin-ui/src/community-api.ts', "import type { CommunityAccountView } from '../../src/domain/admin-contract.ts'\nexport type NewResponse = CommunityAccountView"))
      .toEqual([])
    expect(await lint('admin-ui/src/community-api.ts', 'type ShadowResponse = { enabled: boolean }; export const probe = {} as ShadowResponse'))
      .toContain('dsh-phalanx/admin-contract')
    expect(await lint('admin-ui/src/CommunityAccountsPage.tsx', 'export interface ShadowResponse { enabled: boolean }'))
      .toContain('dsh-phalanx/admin-contract')
  })

  it('requires every use-case module to have a corresponding quick test', async () => {
    expect(await lint('src/use-cases/unregistered.ts', 'export const probe = 1'))
      .toContain('dsh-phalanx/use-case-test')
    expect(await lint('src/use-cases/community-instance-lifecycle.ts', 'export const probe = 1'))
      .toEqual([])
  })

  it('counts code lines and ignores blank and comment lines', async () => {
    const large = Array.from({ length: 501 }, (_, index) => `export const line${index} = ${index}`).join('\n')
    expect(await lint('src/domain/community-account.ts', large)).toContain('dsh-phalanx/file-size')
    const small = Array.from({ length: 501 }, (_, index) => `// comment ${index}`).join('\n') + '\nexport const probe = 1'
    expect(await lint('src/domain/community-account.ts', small)).toEqual([])
  })

  it('checks CSS and source inventory with the same fast lint command', async () => {
    expect(countCssCodeLines('/* header\n * note */\na {}\n\n')).toBe(1)
    expect(countJsCodeLines('// note\nexport const x = 1\n/* block */')).toBe(1)
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-phalanx-architecture-'))
    try {
      await mkdir(join(sandbox, 'src/domain'), { recursive: true })
      await mkdir(join(sandbox, 'admin-ui/src'), { recursive: true })
      await mkdir(join(sandbox, 'tests'), { recursive: true })
      await writeFile(join(sandbox, 'src/domain/valid.ts'), 'export const valid = 1\n')
      await writeFile(join(sandbox, 'admin-ui/src/styles.css'), '/* okay */\na {}\n')
      expect(await auditArchitectureAssets(sandbox)).toEqual([])
      await writeFile(join(sandbox, 'src/orphan.ts'), 'export const orphan = 1\n')
      await writeFile(join(sandbox, 'admin-ui/src/styles.css'), Array.from({ length: 601 }, () => 'a {}').join('\n'))
      await writeFile(join(sandbox, 'tests/fixture.mjs'), Array.from({ length: 801 }, () => '// comment').join('\n'))
      expect(await auditArchitectureAssets(sandbox)).toEqual(expect.arrayContaining([
        expect.stringContaining('no architecture layer'), expect.stringContaining('CSS code lines exceed 600'),
      ]))
      await writeFile(join(sandbox, 'tests/fixture.mjs'), Array.from({ length: 801 }, () => 'export const x = 1').join('\n'))
      expect(await auditArchitectureAssets(sandbox)).toEqual(expect.arrayContaining([
        expect.stringContaining('fixture code lines exceed 800'),
      ]))
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  it('keeps every community source file subject to the architecture rules', async () => {
    expect(JSON.parse(await readFile(`${ROOT}architecture-exemptions.json`, 'utf8'))).toEqual({})
    const original = await readFile(`${ROOT}src/domain/community-config.ts`, 'utf8')
    expect(await lint('src/domain/community-config.ts', original + "\nimport { createServer } from 'node:http'\n"))
      .toContain('dsh-phalanx/layer')
  })
})
