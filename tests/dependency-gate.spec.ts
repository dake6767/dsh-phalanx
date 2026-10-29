import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { auditArchitectureAssets, auditSizeExemptions, countCssCodeLines, countJsCodeLines } from '../scripts/check-architecture-assets.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const lint = async (file: string, source: string): Promise<string[]> => {
  const [result] = await new ESLint({ cwd: ROOT }).lintText(source, { filePath: `${ROOT}${file}` })
  return (result?.messages ?? [])
    .filter(message => message.severity === 2)
    .map(message => message.ruleId ?? 'fatal')
    .filter(rule => rule.startsWith('dsh-phalanx/'))
}

describe('architecture machine gates', () => {
  it('refuses concrete suite identities in platform and management code', async () => {
    for (const file of ['src/domain/probe.ts', 'admin-ui/src/Probe.tsx']) {
      for (const name of ['officecli', 'minimax', 'lark', 'hyperframes', 'wecom', 'pandoc', 'ffmpeg', 'chromium', 'mmx', 'ffprobe', '@larksuite/cli']) {
        expect(await lint(file, `export const tool = '${name}'`)).toContain('dsh-phalanx/suite-identity')
      }
      expect(await lint(file, "export const tool = 'generic-tool' ")).not.toContain('dsh-phalanx/suite-identity')
    }
  })

  it('keeps browser capabilities available on insecure HTTP deployments', async () => {
    for (const file of ['admin-ui/src/Probe.tsx', 'src/dsh/community-probe-client.ts']) {
      for (const source of [
        'export const probe = () => crypto.randomUUID()',
        'export const probe = () => window.crypto["subtle"]',
        'export const probe = () => navigator.clipboard.writeText("text")',
      ]) {
        expect(await lint(file, source)).toContain('dsh-phalanx/browser-http')
      }
      expect(await lint(file, 'export const probe = () => crypto.getRandomValues(new Uint8Array(16))')).toEqual([])
      expect(
        await lint(file, 'export async function probe() { try { await navigator.clipboard.writeText("text") } catch { document.execCommand("copy") } }'),
      ).toEqual([])
    }
    expect(await lint('src/dsh/community-probe-client.ts', 'export const client = `const id = crypto.randomUUID()`')).toContain('dsh-phalanx/browser-http')
    expect(await lint('src/dsh/community-probe-client.ts', 'export const client = `navigator.clipboard.writeText("text")`')).toContain(
      'dsh-phalanx/browser-http',
    )
    for (const source of [
      'export const client = `navigator["clipboard"].writeText("text")`',
      'export const client = `navigator.clipboard.writeText("text"); try { other() } catch { document.execCommand("copy") }`',
      'export const client = "crypto.randomUUID()"',
      'export const client = `try { navigator.clipboard.writeText("text") } catch { document.execCommand("copy") }`',
    ])
      expect(await lint('src/dsh/community-probe-client.ts', source)).toContain('dsh-phalanx/browser-http')
    expect(
      await lint(
        'src/dsh/community-probe-client.ts',
        'export const client = `async function copy() { try { await navigator.clipboard.writeText(${"text"}) } catch { document.execCommand("copy") } }`',
      ),
    ).toEqual([])
    expect(await lint('src/adapters/runtime-command.ts', 'export const probe = () => crypto.randomUUID()')).toEqual([])
  })
  it('rejects cross-layer imports and lets a use case depend on its ports', async () => {
    expect(
      await lint(
        'src/use-cases/community-instance-lifecycle.ts',
        "import type { CommunityRuntimePort } from '../ports/community-runtime.js'\nexport type Probe = CommunityRuntimePort",
      ),
    ).toEqual([])
    expect(
      await lint(
        'src/use-cases/community-instance-lifecycle.ts',
        "import type { PostgresCommunityAccountStore } from '../adapters/postgres-community-accounts.js'\nexport type Probe = PostgresCommunityAccountStore",
      ),
    ).toContain('dsh-phalanx/layer')
    expect(await lint('src/use-cases/community-instance-lifecycle.ts', "export const probe = async () => await import('node:fs')")).toContain(
      'dsh-phalanx/layer',
    )
    expect(await lint('src/domain/community-account.ts', "import '../../scripts/fast-check.mjs'")).toContain('dsh-phalanx/layer')
    expect(await lint('src/domain/community-account.ts', "export const probe = () => process['getBuiltinModule']('node:fs')")).toContain('dsh-phalanx/layer')
    expect(await lint('src/domain/community-account.ts', "export const probe = () => globalThis['fetch']('https://example.test')")).toContain(
      'dsh-phalanx/layer',
    )
  })

  it('requires every control-plane source file to be in a known layer', async () => {
    expect(await lint('src/orphan.ts', 'export const probe = 1')).toContain('dsh-phalanx/layer')
    expect(await lint('src/domain/community-account.ts', 'export const probe = 1')).toEqual([])
  })

  it('rejects infrastructure calls in domain/use cases but allows adapter I/O', async () => {
    expect(await lint('src/domain/community-account.ts', "export const probe = () => fetch('https://example.test')")).toContain('dsh-phalanx/layer')
    expect(
      await lint(
        'src/adapters/postgres-community-accounts.ts',
        "import { readFileSync } from 'node:fs'\nexport const probe = () => readFileSync('/tmp/probe')",
      ),
    ).toEqual([])
  })

  it('rejects error-message branching while permitting typed error branching', async () => {
    expect(await lint('src/domain/community-account.ts', "export const probe = (error: Error) => error.message === 'stopped' ? 1 : 0")).toContain(
      'dsh-phalanx/error-message-branch',
    )
    expect(await lint('src/domain/community-account.ts', 'export const probe = (error: Error) => error instanceof RangeError ? 1 : 0')).toEqual([])
    expect(await lint('src/domain/community-account.ts', "export const probe = (state: { failure: string }) => state.failure === 'stopped' ? 1 : 0")).toContain(
      'dsh-phalanx/error-message-branch',
    )
    expect(await lint('src/domain/community-account.ts', "export const probe = (error: Error) => error['message'] === 'stopped' ? 1 : 0")).toContain(
      'dsh-phalanx/error-message-branch',
    )
    expect(
      await lint(
        'src/domain/community-account.ts',
        "export const probe = (error: Error) => { const reason = error.message; return reason === 'stopped' ? 1 : 0 }",
      ),
    ).toContain('dsh-phalanx/error-message-branch')
  })

  it('keeps DSH protocol constants in the seam layer', async () => {
    expect(await lint('src/inbound/platform-session.ts', "export const endpoint = '/api/remote.mux'")).toContain('dsh-phalanx/dsh-seam')
    expect(await lint('src/dsh/container.ts', "export const endpoint = '/api/remote.mux'")).toEqual([])
    expect(await lint('src/inbound/platform-session.ts', 'export const endpoint = `/api/${"remote.mux"}`')).toContain('dsh-phalanx/dsh-seam')
    expect(await lint('src/inbound/platform-session.ts', "export const endpoint = 'pluginManager/getInstalled'")).toContain('dsh-phalanx/dsh-seam')
    expect(await lint('src/domain/community-account.ts', "export const event = 'llm/stream'")).toContain('dsh-phalanx/dsh-seam')
    expect(await lint('src/dsh/community-profile.ts', "export const event = 'llm/stream'")).toEqual([])
  })

  it('rejects named plugin and service branches while accepting generic row matching', async () => {
    expect(await lint('src/inbound/plugin-proxy.ts', "export const probe = (pluginId: string) => pluginId === 'firecrawl'")).toContain(
      'dsh-phalanx/plugin-special-case',
    )
    expect(
      await lint(
        'src/inbound/plugin-proxy.ts',
        "export const probe = (serviceName: string) => { switch (serviceName) { case 'Tavily': return 1; default: return 0 } }",
      ),
    ).toContain('dsh-phalanx/plugin-special-case')
    expect(await lint('src/inbound/plugin-proxy.ts', "export const probe = (plugin: { id: string }) => plugin.id === 'firecrawl'")).toContain(
      'dsh-phalanx/plugin-special-case',
    )
    expect(await lint('src/inbound/plugin-proxy.ts', "export const probe = (service: { name: string }) => service.name === 'Tavily'")).toContain(
      'dsh-phalanx/plugin-special-case',
    )
    expect(
      await lint('src/inbound/plugin-proxy.ts', 'export const probe = (pluginId: string, row: { pluginId: string }) => row.pluginId === pluginId'),
    ).toEqual([])
  })

  it('keeps file, SQLite and container I/O in adapters', async () => {
    expect(await lint('src/inbound/platform-session.ts', "import { readFileSync } from 'node:fs'\nexport const probe = readFileSync")).toContain(
      'dsh-phalanx/io-exit',
    )
    expect(await lint('src/adapters/postgres-community-accounts.ts', "import { readFileSync } from 'node:fs'\nexport const probe = readFileSync")).toEqual([])
    expect(await lint('src/inbound/platform-session.ts', "export const probe = () => process['getBuiltinModule']('node:fs')")).toContain('dsh-phalanx/io-exit')
  })

  it('requires browser management responses to use the shared contract', async () => {
    expect(await lint('admin-ui/src/community-api.ts', 'export interface NewResponse { enabled: boolean }')).toContain('dsh-phalanx/admin-contract')
    expect(
      await lint(
        'admin-ui/src/community-api.ts',
        "import type { CommunityAccountView } from '../../src/domain/admin-contract.ts'\nexport type NewResponse = CommunityAccountView",
      ),
    ).toEqual([])
    expect(await lint('admin-ui/src/community-api.ts', 'type ShadowResponse = { enabled: boolean }; export const probe = {} as ShadowResponse')).toContain(
      'dsh-phalanx/admin-contract',
    )
    expect(await lint('admin-ui/src/CommunityAccountsPage.tsx', 'export interface ShadowResponse { enabled: boolean }')).toContain('dsh-phalanx/admin-contract')
  })

  it('requires every use-case module to have a corresponding quick test', async () => {
    expect(await lint('src/use-cases/unregistered.ts', 'export const probe = 1')).toContain('dsh-phalanx/use-case-test')
    expect(await lint('src/use-cases/community-instance-lifecycle.ts', 'export const probe = 1')).toEqual([])
  })

  it('counts code lines and ignores blank and comment lines', async () => {
    const large = Array.from({ length: 501 }, (_, index) => `export const line${index} = ${index}`).join('\n')
    expect(await lint('src/domain/community-account.ts', large)).toContain('dsh-phalanx/file-size')
    const small = Array.from({ length: 501 }, (_, index) => `// comment ${index}`).join('\n') + '\nexport const probe = 1'
    expect(await lint('src/domain/community-account.ts', small)).toEqual([])
  })

  it('holds every exempted file to exactly its ratcheted ceiling and drops the exemption once it fits', async () => {
    // Read the live ledger so the case survives each ticket lowering or removing its entry.
    const { fileSize } = JSON.parse(await readFile(`${ROOT}architecture-exemptions.json`, 'utf8')) as { fileSize: Record<string, { maxLines: number }> }
    const limit = (file: string) => (file.startsWith('src/') ? 500 : file.startsWith('admin-ui/src/') ? 600 : 800)
    const lines = (count: number) => Array.from({ length: count }, (_, index) => `export const line${index} = ${index}`).join('\n')
    for (const [file, { maxLines }] of Object.entries(fileSize)) {
      expect(await lint(file, lines(maxLines)), file).not.toContain('dsh-phalanx/file-size')
      for (const count of [maxLines + 1, maxLines - 1, limit(file)])
        expect(await lint(file, lines(count)), `${file} ${count}`).toContain('dsh-phalanx/file-size')
    }
  })

  it('names every advisory lock in one module', async () => {
    // A bare lock number elsewhere could collide with or silently diverge from the deployed contract.
    const { readdir } = await import('node:fs/promises')
    const sources = (await readdir(`${ROOT}src`, { recursive: true })).filter(file => file.endsWith('.ts') && file !== 'adapters/advisory-locks.ts')
    const offenders: string[] = []
    for (const file of sources) {
      const text = await readFile(`${ROOT}src/${file}`, 'utf8')
      // Inline numeric keys, and the platform's key range passed as a parameter.
      if (/pg_(?:try_)?advisory_(?:xact_)?(?:un)?lock(?:_shared)?\(\s*\d/u.test(text) || /\b1685282\d{3}\b/u.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
    const { AdvisoryLock } = await import('../src/adapters/advisory-locks.js')
    expect(new Set(Object.values(AdvisoryLock)).size).toBe(Object.keys(AdvisoryLock).length)
  })

  it('accepts only an existing, ticketed size-exemption ledger', () => {
    const exists = (file: string) => file === 'src/a.ts'
    expect(auditSizeExemptions({ fileSize: { 'src/a.ts': { maxLines: 600, ticket: '0.1.26/04' } } }, exists)).toEqual([])
    expect(auditSizeExemptions({ fileSize: { 'src/b.ts': { maxLines: 600, ticket: '0.1.26/04' } } }, exists)).toEqual([expect.stringContaining('missing file')])
    expect(auditSizeExemptions({ fileSize: { 'scripts/x.mjs': { maxLines: 600, ticket: '0.1.26/04' } } }, () => true)).toEqual([
      expect.stringContaining('outside a size-checked tree'),
    ])
    for (const row of [
      { maxLines: 0, ticket: '0.1.26/04' },
      { maxLines: 600 },
      { maxLines: 600, ticket: 'later' },
      { maxLines: 600, ticket: '0.1.26/04', reason: 'x' },
    ])
      expect(auditSizeExemptions({ fileSize: { 'src/a.ts': row } }, exists)).toEqual([expect.stringContaining('owning ticket')])
    expect(auditSizeExemptions({ fileSize: {}, other: {} }, exists)).toEqual([expect.stringContaining('only a fileSize object')])
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
      expect(await auditArchitectureAssets(sandbox)).toEqual(
        expect.arrayContaining([expect.stringContaining('no architecture layer'), expect.stringContaining('CSS code lines exceed 600')]),
      )
      await writeFile(join(sandbox, 'tests/fixture.mjs'), Array.from({ length: 801 }, () => 'export const x = 1').join('\n'))
      expect(await auditArchitectureAssets(sandbox)).toEqual(expect.arrayContaining([expect.stringContaining('fixture code lines exceed 800')]))
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  it('keeps every community source file subject to the architecture rules', async () => {
    // The ledger only shrinks: no new files, and no ceiling above the one recorded when formatting revealed it.
    const initial: Record<string, number> = {
      'admin-ui/src/CommunityMcpEditor.tsx': 657,
      'admin-ui/src/CommunitySuitesPage.tsx': 893,
      'src/adapters/community-runtime-driver.ts': 506,
      'src/composition/community-application.ts': 991,
      'src/domain/admin-contract.ts': 753,
      'src/domain/plugin-messages.ts': 507,
      'src/use-cases/mcp-services.ts': 695,
      'src/use-cases/plugin-library.ts': 670,
      'src/use-cases/runtime-dependencies.ts': 663,
      'src/use-cases/skill-library.ts': 941,
      'src/use-cases/suite-catalog.ts': 1048,
      'tests/suite-catalog-suites.spec.ts': 854,
      'tests/support/installed-upgrade-scenario.ts': 991,
    }
    const { fileSize } = JSON.parse(await readFile(`${ROOT}architecture-exemptions.json`, 'utf8')) as { fileSize: Record<string, { maxLines: number }> }
    for (const [file, { maxLines }] of Object.entries(fileSize)) expect(maxLines, file).toBeLessThanOrEqual(initial[file] ?? 0)
    const original = await readFile(`${ROOT}src/domain/community-config.ts`, 'utf8')
    expect(await lint('src/domain/community-config.ts', original + "\nimport { createServer } from 'node:http'\n")).toContain('dsh-phalanx/layer')
  })
})
