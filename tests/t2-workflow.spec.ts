import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

it('only hands off the prepared artifact after an always-run aggregation of all independent runners', () => {
  const workflow = parse(readFileSync('.github/workflows/linux-t2.yml', 'utf8'))
  expect(workflow.on.workflow_call.outputs.image_artifact.value).toBe('${{ jobs.amd64-verified.outputs.image_artifact }}')
  const gate = workflow.jobs['amd64-verified']
  expect(gate.needs).toEqual(expect.arrayContaining(['scope', 'amd64-bundle', 'amd64-tests']))
  expect(gate.if).toContain('always()')
  const verify = gate.steps.find((s: { id?: string }) => s.id === 'verified')
  expect(verify.if).toBe('always()')
  expect(verify.run).toContain('test "$BUNDLE_RESULT" = success')
  expect(verify.run).toContain('test "$TEST_RESULT" = success')
  expect(verify.run.indexOf('t2-shards.mjs verify')).toBeLessThan(verify.run.indexOf("printf 'image_artifact="))
  expect(workflow.jobs['amd64-tests'].strategy).toMatchObject({ 'fail-fast': false, 'max-parallel': 4 })
  expect(workflow.jobs['native-arm64']['runs-on']).toBe('ubuntu-24.04-arm')
  expect(workflow.jobs['formal-upgrade'].if).toContain("needs.scope.outputs.upgrade == 'true'")
})

it.each(['false', 'true'])('runs full arm64 acceptance unless development image mode is %s', development => {
  const workflow = parse(readFileSync('.github/workflows/linux-t2.yml', 'utf8'))
  const step = workflow.jobs['native-arm64'].steps.find((entry: { name: string }) => entry.name === 'Run the shared rootless Linux command')
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', `cat() { printf '%s\\n' fixture-image; }; sudo() { printf '%s\\n' "$@"; };\n${step.run}`], {
    encoding: 'utf8', env: { PATH: process.env.PATH, EXPECTED_ARCH: 'arm64', DEVELOPMENT_IMAGE_ONLY: development,
      BASELINE_RUN: '12345', TEST_FILES: 'tests/subset.e2e.ts', SOURCE_SHA: 'a'.repeat(40) },
  })
  expect(result.status, result.stderr).toBe(0)
  const argv = result.stdout.trim().split('\n')
  expect(argv).toContain('scripts/validation/t2-host.py')
  expect(argv.includes('--smoke')).toBe(development === 'true')
  expect(argv).not.toContain('--files')
  expect(argv).not.toContain('--reuse-baseline')
  expect(step.env.DEVELOPMENT_IMAGE_ONLY).toBe('${{ inputs.development_image_only }}')
})
