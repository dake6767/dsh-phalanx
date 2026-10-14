import { expect, it } from 'vitest'
import { contributionDeclaration, contributionPrefill, inspectContributionCredentials, excludedContributionFile } from '../src/domain/contribution-checks.js'

it('accepts only value-free declarations under the existing execution configuration rules', () => {
  const declaration = { purpose: 'Search documents', execution: { commands: [{ command: 'search', blocked: ['configure'] }], variables: [{ name: 'SEARCH_KEY', purpose: 'Authenticate', application: 'Provider dashboard' }], prepare: 'npm ci --ignore-scripts' } }
  expect(contributionDeclaration(declaration)).toEqual(declaration)
  for (const name of ['PATH', 'DSH_TOKEN', 'NODE_OPTIONS']) expect(() => contributionDeclaration({ ...declaration, execution: { ...declaration.execution, variables: [{ name, purpose: 'Auth', application: 'Dashboard' }] } })).toThrow()
  expect(() => contributionDeclaration({ ...declaration, execution: { ...declaration.execution, variables: [{ name: 'SEARCH_KEY', value: 'should-never-be-accepted' }] } })).toThrow()
  expect(() => contributionDeclaration({ ...declaration, execution: { ...declaration.execution, commands: [{ command: 'search && leak', blocked: [] }] } })).toThrow()
})

it('returns credential finding codes and advice without any matched values, and identifies excluded file types', () => {
  const high = 'X8nQ3bV7sR2cP9mK5hT1yL6zF0aD4wE', low = 'personal-key'
  const findings = inspectContributionCredentials([{ path: 'search.js', content: `const apiKey = "${high}"; const token = "${low}";` }, { path: 'private.txt', content: '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----' }])
  expect(findings.map(row => [row.code, row.severity])).toEqual([['contribution-credential-high', 'reject'], ['contribution-credential-low', 'warning'], ['contribution-private-key', 'reject']])
  expect(JSON.stringify(findings)).not.toContain(high); expect(JSON.stringify(findings)).not.toContain(low)
  expect(findings.every(row => row.advice.length > 0)).toBe(true)
  expect(inspectContributionCredentials([{ path: 'search.js', content: 'const apiKey = process.env.SEARCH_KEY; const token = "example-token";' }])).toEqual([])
  for (const path of ['.env', '.env.local', 'nested/.env.production', 'key.pem', 'cert.cer', 'key.p12', 'cert.crt']) expect(excludedContributionFile(path)).toBe(true)
  expect(excludedContributionFile('scripts/search.js')).toBe(false)
})

it('prefills delegated names without credentials and preserves an existing configuration when adding declaration items', () => {
  const declaration = contributionDeclaration({ purpose: 'Search', execution: { commands: [{ command: 'search', blocked: ['login'] }], variables: [{ name: 'SEARCH_KEY', purpose: 'Authenticate', application: 'Dashboard' }], prepare: 'npm ci' } })
  expect(contributionPrefill(declaration)).toEqual({ enabled: false, commands: [{ command: 'search', blocked: ['login'] }], variables: [{ name: 'SEARCH_KEY', secret: true }], prepare: 'npm ci' })
  const previous = { enabled: true, commands: [{ command: 'old-search', blocked: [] }], variables: [{ name: 'SEARCH_KEY', secret: true, configured: true }], prepare: 'old preparation' }
  expect(contributionPrefill(declaration, previous)).toMatchObject({ enabled: true, commands: [...previous.commands, { command: 'search', blocked: ['login'] }], variables: [{ name: 'SEARCH_KEY', secret: true }], prepare: previous.prepare })
})
