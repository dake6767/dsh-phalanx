import { expect, it } from 'vitest'
import {
  contributionDeclaration,
  contributionPrefill,
  inspectContributionCredentials,
  excludedContributionFile,
  scanContributionCredentials,
} from '../src/domain/contribution-checks.js'

it('accepts only value-free declarations under the existing execution configuration rules', () => {
  const declaration = {
    purpose: 'Search documents',
    execution: {
      commands: [{ command: 'search', blocked: ['configure'] }],
      variables: [{ name: 'SEARCH_KEY', purpose: 'Authenticate', application: 'Provider dashboard' }],
      prepare: 'npm ci --ignore-scripts',
    },
  }
  expect(contributionDeclaration(declaration)).toEqual({
    purpose: declaration.purpose,
    execution: { commands: declaration.execution.commands, variables: declaration.execution.variables },
  })
  for (const name of ['PATH', 'DSH_TOKEN', 'NODE_OPTIONS'])
    expect(() =>
      contributionDeclaration({ ...declaration, execution: { ...declaration.execution, variables: [{ name, purpose: 'Auth', application: 'Dashboard' }] } }),
    ).toThrow()
  expect(() =>
    contributionDeclaration({
      ...declaration,
      execution: { ...declaration.execution, variables: [{ name: 'SEARCH_KEY', value: 'should-never-be-accepted' }] },
    }),
  ).toThrow()
  expect(() =>
    contributionDeclaration({ ...declaration, execution: { ...declaration.execution, commands: [{ command: 'search && leak', blocked: [] }] } }),
  ).toThrow()
})

it('returns credential finding codes and advice without any matched values, and identifies excluded file types', () => {
  const high = 'X8nQ3bV7sR2cP9mK5hT1yL6zF0aD4wE',
    low = 'personal-key'
  const findings = inspectContributionCredentials([
    { path: 'search.js', content: `const apiKey = "${high}"; const token = "${low}";` },
    { path: 'private.txt', content: '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----' },
  ])
  expect(findings.map(row => [row.code, row.severity])).toEqual([
    ['contribution-credential-high', 'reject'],
    ['contribution-credential-low', 'warning'],
    ['contribution-private-key', 'reject'],
  ])
  expect(JSON.stringify(findings)).not.toContain(high)
  expect(JSON.stringify(findings)).not.toContain(low)
  expect(findings.every(row => row.advice.length > 0)).toBe(true)
  expect(inspectContributionCredentials([{ path: 'search.js', content: 'const apiKey = process.env.SEARCH_KEY; const token = "example-token";' }])).toEqual([])
  for (const path of ['.env', '.env.local', 'nested/.env.production', 'key.pem', 'cert.cer', 'key.p12', 'cert.crt'])
    expect(excludedContributionFile(path)).toBe(true)
  expect(excludedContributionFile('scripts/search.js')).toBe(false)
})

it('prefills delegated names without credentials and preserves an existing configuration when adding declaration items', () => {
  const declaration = contributionDeclaration({
    purpose: 'Search',
    execution: {
      commands: [{ command: 'search', blocked: ['login'] }],
      variables: [{ name: 'SEARCH_KEY', purpose: 'Authenticate', application: 'Dashboard' }],
      prepare: 'npm ci',
    },
  })
  expect(contributionPrefill(declaration)).toEqual({
    enabled: false,
    commands: [{ command: 'search', blocked: ['login'] }],
    variables: [{ name: 'SEARCH_KEY', secret: true }],
  })
  const previous = {
    enabled: true,
    commands: [{ command: 'old-search', blocked: [] }],
    variables: [{ name: 'SEARCH_KEY', secret: true, configured: true }],
    prepare: 'old preparation',
    runtimeDependencies: ['existing'],
  }
  expect(contributionPrefill(declaration, previous)).toMatchObject({
    enabled: true,
    commands: [...previous.commands, { command: 'search', blocked: ['login'] }],
    variables: [{ name: 'SEARCH_KEY', secret: true }],
    runtimeDependencies: ['existing'],
  })
  expect(contributionPrefill(declaration, previous)).not.toHaveProperty('prepare')
})

it('preserves public references only in presentation while keeping all findings and high-confidence redaction', () => {
  const reference = 'ANYSEARCH_API_KEY',
    high = 'X8nQ3bV7sR2cP9mK5hT1yL6zF0aD4wE',
    prefixed = 'sk-' + 'A'.repeat(32)
  const files = [{ path: 'config', content: JSON.stringify({ apiKeyEnv: reference, apiKey: high, token: 'personal-key', password: prefixed }) }]
  const shown = scanContributionCredentials(files, new Set([reference, high, prefixed]))
  expect(shown.findings).toEqual(inspectContributionCredentials(files))
  expect(JSON.parse(shown.files[0]!.content)).toEqual({ apiKeyEnv: reference, apiKey: '[redacted]', token: '[redacted]', password: '[redacted]' })
})

it('rejects high-confidence values under quoted JSON credential field names', () => {
  const secret = 'X8nQ3bV7sR2cP9mK5hT1yL6zF0aD4wE'
  for (const field of ['key', 'token', 'secret', 'password']) {
    const result = scanContributionCredentials([{ path: 'config.json', content: JSON.stringify({ [field]: secret }) }])
    expect(result.findings).toMatchObject([{ code: 'contribution-credential-high', severity: 'reject' }])
    expect(result.files[0]!.content).not.toContain(secret)
  }
})

it('preserves non-string JSON literals while still hiding quoted credential strings', () => {
  const config = { search: { secret: true, token: false, password: null, maxTokens: 4096, key: 'true', note: 'true' } }
  const result = scanContributionCredentials([{ path: 'config.json', content: JSON.stringify(config) }])
  expect(JSON.parse(result.files[0]!.content)).toEqual({
    search: { secret: true, token: false, password: null, maxTokens: 4096, key: '[redacted]', note: '[redacted]' },
  })
})

it('hides every string copy of an identified credential without changing non-string config values', () => {
  for (const secret of ['personal-key', 'X8nQ3bV7sR2cP9mK5hT1yL6zF0aD4wE', '1234']) {
    const result = scanContributionCredentials([{ path: 'config.json', content: JSON.stringify({ token: secret, note: secret, key: 1234 }) }])
    expect(JSON.parse(result.files[0]!.content)).toEqual({ token: '[redacted]', note: '[redacted]', key: 1234 })
  }
})

it('still checks unquoted shell credential strings even when they resemble JSON literals', () => {
  const result = scanContributionCredentials([{ path: 'setup.sh', content: 'export API_TOKEN=1234567890; PASSWORD=true' }])
  expect(result.findings).toMatchObject([{ code: 'contribution-credential-low', severity: 'warning' }])
  expect(result.files[0]!.content).toBe('export API_TOKEN=[redacted]; PASSWORD=[redacted]')
})

it('accepts required command instructions without exposing the dependency library and ignores retired preparation', () => {
  const requiredCommands = [
    {
      name: 'lark-cli',
      purpose: 'Read team documents; members must sign in themselves.',
      installation: 'Install the pinned official Linux CLI binary into bin.',
    },
  ]
  const input = { purpose: 'Team documents', requiredCommands, execution: { commands: [], variables: [], prepare: { ignored: 'obsolete format' } } }
  expect(contributionDeclaration(input)).toEqual({ purpose: input.purpose, requiredCommands, execution: { commands: [], variables: [] } })
  for (const changed of [
    [{ ...requiredCommands[0], value: 'private-value' }],
    [{ ...requiredCommands[0], name: 'lark-cli; curl' }],
    [{ ...requiredCommands[0], installation: 'export API_KEY=actual-private-value' }],
    [requiredCommands[0], requiredCommands[0]],
    Array.from({ length: 65 }, (_, index) => ({ ...requiredCommands[0], name: `tool-${index}` })),
  ])
    expect(() => contributionDeclaration({ purpose: input.purpose, requiredCommands: changed })).toThrow()
})
