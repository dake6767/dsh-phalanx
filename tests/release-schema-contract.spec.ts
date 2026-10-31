import { expect, it } from 'vitest'
import { releaseCompatibility } from '../scripts/release/schema-contract.mjs'
import { PLATFORM_SCHEMAS, registeredSchemas } from '../src/adapters/platform-schema-registry.js'

it('derives every target and legacy accounts from the same ordered packaged registry', () => {
  const inventory = registeredSchemas([...PLATFORM_SCHEMAS, { name: 'isolated_probe', migrations: [{ version: 1, name: 'probe', sql: '' }] }]).map(schema => ({
    name: schema.name,
    target: schema.migrations.at(-1)!.version,
  }))
  const policy = {
    protocol: 3,
    schemas: [
      { name: 'dsh_phalanx', sourceMin: 15, sourceMax: 15 },
      { name: 'isolated_probe', sourceMin: 0, sourceMax: 0 },
    ],
  }
  expect(releaseCompatibility(policy, inventory)).toEqual({
    ...policy,
    schemas: [
      { name: 'dsh_phalanx', sourceMin: 15, sourceMax: 15, target: 15 },
      { name: 'isolated_probe', sourceMin: 0, sourceMax: 0, target: 1 },
    ],
    accounts: { sourceMin: 15, sourceMax: 15, target: 15 },
  })
  for (const schemas of [
    policy.schemas.slice(0, 1),
    [...policy.schemas, { name: 'unregistered', sourceMin: 0, sourceMax: 0 }],
    [{ ...policy.schemas[0], sourceMax: 16 }, policy.schemas[1]],
    [{ ...policy.schemas[0], target: 15 }, policy.schemas[1]],
  ]) {
    expect(() => releaseCompatibility({ ...policy, schemas }, inventory)).toThrow()
  }
})
