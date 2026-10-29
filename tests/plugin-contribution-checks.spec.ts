import { pluginAccessView } from '../src/domain/plugin-access-presentation.js'
import { mergePluginAccessInput } from '../src/domain/plugin-access.js'
import { PluginContributionChecks } from '../src/adapters/plugin-contribution-checks.js'
import { expect, it } from 'vitest'
import { pluginDeclaration, pluginContributionFindings, pluginContributionPrefill } from '../src/domain/plugin-contribution-checks.js'
import { YamlPluginAccessSyntax } from '../src/adapters/plugin-access-syntax.js'
import type { PreparedPlugin } from '../src/domain/plugin-library.js'
const syntax = new YamlPluginAccessSyntax()
const prepared: PreparedPlugin = {
  packageName: 'team-search',
  version: '1.0.0',
  integrity: 'pinned',
  artifact: 'artifacts/private',
  runtimeRevision: 'runtime',
  title: 'Search',
  description: '',
  dependencies: {},
  bundlePatch: '[{"insert":[{"id":"search","name":"team-search"}]}]',
}
const declaration = {
  upstreams: [{ name: 'search', baseUrl: 'https://provider.example/api', headers: [{ name: 'Authorization', value: 'Bearer {credential}' }] }],
  environment: [{ name: 'SEARCH_KEY', secret: true, purpose: 'Authenticate requests', application: 'Provider dashboard', reference: '{access-token}' }],
  entriesYaml: 'search:\n  baseURL: "{upstream:search}"\n  apiKeyEnv: SEARCH_KEY',
}
it('validates value-free plugin declarations through the same access and upstream policy as administrator configuration', () => {
  const checked = pluginDeclaration(declaration)
  expect(pluginContributionFindings(checked, prepared, syntax)).toEqual([])
  expect(() => pluginDeclaration({ ...declaration, upstreams: [{ ...declaration.upstreams[0], credential: 'actual value' }] })).toThrow(
    expect.objectContaining({ code: 'contribution-invalid' }),
  )
  expect(
    pluginContributionFindings({ ...checked, environment: [{ ...checked.environment[0]!, name: 'DSH_PHALANX_PRIVATE' }] }, prepared, syntax),
  ).toContainEqual(expect.objectContaining({ code: 'contribution-plugin-reserved', severity: 'reject' }))
  expect(pluginContributionFindings({ ...checked, entriesYaml: 'missing: {}' }, prepared, syntax)).toContainEqual(
    expect.objectContaining({ code: 'contribution-plugin-entry', severity: 'reject' }),
  )
  expect(pluginContributionFindings({ ...checked, entriesYaml: 'search:\n  baseURL: "{upstream:missing}"' }, prepared, syntax)).toContainEqual(
    expect.objectContaining({ code: 'contribution-plugin-reference', severity: 'reject' }),
  )
})
it('rejects an unreferenced upstream with advice and downgrades an explicit direct-connection reason', () => {
  const checked = pluginDeclaration({ ...declaration, entriesYaml: 'search:\n  baseURL: https://provider.example/api' })
  expect(pluginContributionFindings(checked, prepared, syntax)).toContainEqual(
    expect.objectContaining({ code: 'contribution-plugin-upstream-unused', severity: 'reject', advice: expect.stringContaining('{upstream:search}') }),
  )
  expect(
    pluginContributionFindings(
      { ...checked, upstreams: [{ ...checked.upstreams[0]!, directReason: 'Public endpoint with no authentication' }] },
      prepared,
      syntax,
    ),
  ).toContainEqual(expect.objectContaining({ code: 'contribution-plugin-upstream-unused', severity: 'warning' }))
})
it('prefills only new declaration fields while retaining administrator configuration and write-only credential status', () => {
  const settings = {
    revision: 'existing',
    environment: [
      { name: 'SEARCH_KEY', value: '{access-token}' },
      { name: 'PRIOR', value: 'old' },
    ],
    entriesYaml: 'search:\n  baseURL: "{upstream:prior}"\n  nested:\n    timeout: 30',
    entries: { search: { baseURL: '{upstream:prior}', nested: { timeout: 30 } } },
  }
  const previous = pluginAccessView(settings, ['search'])
  const next = pluginContributionPrefill(pluginDeclaration(declaration), syntax, previous, [
    { name: 'search', baseUrl: 'https://prior.example/api', headers: [], credential: { configured: true, last4: 'test' } },
  ])
  expect(next.upstreams[0]).toMatchObject({ baseUrl: 'https://prior.example/api', credential: { configured: true, last4: 'test' } })
  expect(next.access.environment).toEqual([
    { name: 'SEARCH_KEY', value: '' },
    { name: 'PRIOR', value: '' },
  ])
  expect(syntax.parse(mergePluginAccessInput(next.access, settings, source => syntax.parse(source)).entriesYaml)).toEqual({
    search: { baseURL: '{upstream:prior}', nested: { timeout: 30 }, apiKeyEnv: 'SEARCH_KEY' },
  })
  expect(next.removed.environment).toEqual(['PRIOR'])
})

it('requires explicit retention for install, external-domain, size and low-confidence credential warnings without downgrading rejects', () => {
  const checker = new PluginContributionChecks(),
    inspection = {
      files: ['package.json'],
      keyFiles: [],
      findings: [
        { code: 'contribution-large' as const, severity: 'warning' as const, path: 'package', advice: 'Reduce package size.' },
        { code: 'contribution-credential-low' as const, severity: 'warning' as const, path: 'config', advice: 'Review this possible credential.' },
      ],
      installScripts: ['install'],
      externalHosts: ['provider.example', 'unexpected.example'],
    }
  const input = { purpose: 'Share', plugin: pluginDeclaration(declaration) }
  expect(() => checker.check(input, prepared, inspection, false)).toThrow(
    expect.objectContaining({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: 'contribution-plugin-install-script' }),
        expect.objectContaining({ code: 'contribution-plugin-domain', path: 'unexpected.example' }),
      ]),
    }),
  )
  expect(checker.check(input, prepared, inspection, true).map(row => row.code)).toEqual([
    'contribution-large',
    'contribution-credential-low',
    'contribution-plugin-install-script',
    'contribution-plugin-domain',
  ])
  expect(() =>
    checker.check(
      input,
      prepared,
      {
        ...inspection,
        findings: [{ code: 'contribution-credential-high' as const, severity: 'reject' as const, path: 'cordis.patch.yml', advice: 'Remove token.' }],
      },
      true,
    ),
  ).toThrow(expect.objectContaining({ findings: expect.arrayContaining([expect.objectContaining({ severity: 'reject' })]) }))
  expect(pluginContributionFindings({ ...input.plugin, entriesYaml: '[malformed' }, prepared, syntax)).toContainEqual(
    expect.objectContaining({ code: 'contribution-plugin-access', severity: 'reject' }),
  )
})

it('uses the selected npm host for the plugin external-domain precheck', async () => {
  const { resolveDownloadSources } = await import('../src/domain/download-source.js')
  let sources = resolveDownloadSources({ preset: 'official' })
  const checker = new PluginContributionChecks({ current: () => sources })
  const inspection = { files: ['package.json'], keyFiles: [], findings: [], externalHosts: ['registry.npmmirror.com'] }
  expect(() => checker.check(undefined, prepared, inspection, false)).toThrow(
    expect.objectContaining({
      findings: expect.arrayContaining([expect.objectContaining({ code: 'contribution-plugin-domain', path: 'registry.npmmirror.com' })]),
    }),
  )
  sources = resolveDownloadSources({ preset: 'mainland' })
  expect(checker.check(undefined, prepared, inspection, false)).toEqual([])
  expect(() => checker.check(undefined, prepared, { ...inspection, externalHosts: ['registry.npmmirror.com.evil.example'] }, false)).toThrow(
    expect.objectContaining({ findings: expect.arrayContaining([expect.objectContaining({ code: 'contribution-plugin-domain' })]) }),
  )
})
