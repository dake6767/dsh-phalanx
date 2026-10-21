import { expect, it } from 'vitest'
import { effectiveInstanceResources, instanceResourceLimits, instanceResourcesApplied, memoryLimitReduced, sameInstanceResources, suggestedInstanceResources, UNLIMITED_INSTANCE_RESOURCES } from '../src/domain/instance-resources.js'

it('inherits the defaults or replaces all three limits with the member override', () => {
  const defaults = { cpus: 2, memoryMiB: 2048, pids: 256 }
  expect(effectiveInstanceResources(defaults, undefined)).toEqual(defaults)
  expect(effectiveInstanceResources(defaults, UNLIMITED_INSTANCE_RESOURCES)).toEqual({ cpus: null, memoryMiB: null, pids: null })
  const effective = effectiveInstanceResources(defaults, { cpus: 0.5, memoryMiB: null, pids: 64 })
  expect(effective).toEqual({ cpus: 0.5, memoryMiB: null, pids: 64 })
  expect(effectiveInstanceResources(defaults, undefined)).not.toBe(defaults)
})

it('suggests half the host memory capped at 4 GiB, half its CPUs with at least one, and 2048 processes', () => {
  expect(suggestedInstanceResources({ memoryBytes: 16 * 1024 ** 3, cpuCount: 8 })).toEqual({ memoryMiB: 4096, cpus: 4, pids: 2048 })
  expect(suggestedInstanceResources({ memoryBytes: 3 * 1024 ** 3, cpuCount: 3 })).toEqual({ memoryMiB: 1536, cpus: 1.5, pids: 2048 })
  expect(suggestedInstanceResources({ memoryBytes: 1024 ** 3, cpuCount: 1 })).toEqual({ memoryMiB: 512, cpus: 1, pids: 2048 })
})

it('requires an explicit valid number or unlimited for every field', () => {
  for (const input of [undefined, {}, { cpus: null, memoryMiB: null }, { cpus: '1', memoryMiB: null, pids: null }, { cpus: 0, memoryMiB: null, pids: null }, { cpus: Infinity, memoryMiB: null, pids: null }, { cpus: null, memoryMiB: -1, pids: null }, { cpus: null, memoryMiB: Number.MAX_SAFE_INTEGER, pids: null }, { cpus: null, memoryMiB: null, pids: 1.5 }]) {
    expect(() => instanceResourceLimits(input)).toThrow()
  }
  expect(instanceResourceLimits({ cpus: 0.25, memoryMiB: 1 / 1024, pids: 16 })).toEqual({ cpus: 0.25, memoryMiB: 1 / 1024, pids: 16 })
})

it('compares target and effective limits and warns when memory is reduced from unlimited', () => {
  expect(sameInstanceResources(UNLIMITED_INSTANCE_RESOURCES, { cpus: null, memoryMiB: null, pids: null })).toBe(true)
  expect(sameInstanceResources(UNLIMITED_INSTANCE_RESOURCES, { cpus: 1, memoryMiB: null, pids: null })).toBe(false)
  expect(memoryLimitReduced(null, 512)).toBe(true)
  expect(memoryLimitReduced(1024, 512)).toBe(true)
  expect(memoryLimitReduced(512, 1024)).toBe(false)
  expect(memoryLimitReduced(512, null)).toBe(false)
})

it('recognizes CPU quota rounding while requiring the actual swap setting to match', () => {
  const target = { cpus: 0.333333, memoryMiB: 512, pids: 128 }
  expect(instanceResourcesApplied({ limits: { ...target, cpus: 0.33333 }, swapMiB: 0 }, target)).toBe(true)
  expect(instanceResourcesApplied({ limits: target, swapMiB: null }, target)).toBe(false)
  expect(instanceResourcesApplied({ limits: UNLIMITED_INSTANCE_RESOURCES, swapMiB: 0 }, UNLIMITED_INSTANCE_RESOURCES)).toBe(false)
})
