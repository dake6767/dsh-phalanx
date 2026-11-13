import { spawnSync } from 'node:child_process'

export function pythonFixtureCases(fixture: string): string[] {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import json, runpy, sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
namespace = runpy.run_path(sys.argv[1], run_name='fixture_cases')
loader = unittest.TestLoader()
print(json.dumps(sorted(
    case.__name__ + '.' + method
    for case in namespace.values()
    if isinstance(case, type) and issubclass(case, unittest.TestCase)
       and case.__module__ == 'fixture_cases'
    for method in loader.getTestCaseNames(case)
)))
`,
      `tests/fixtures/${fixture}.py`,
    ],
    { encoding: 'utf8', timeout: 15000 },
  )
  if (result.status !== 0) throw new Error(`Cannot collect ${fixture} cases: ${result.stderr}`)
  const value: unknown = JSON.parse(result.stdout)
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((name: unknown) => typeof name === 'string' && /^[A-Za-z_]\w*\.test_\w+$/.test(name)) ||
    new Set(value).size !== value.length
  )
    throw new Error(`Invalid ${fixture} case list`)
  return value as string[]
}
