import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { selection, validateFiles } from './t2-plan.mjs'

export function verifyRegular(regular, files) {
  validateFiles(files)
  const assertions = regular.testResults.flatMap(file => file.assertionResults)
  const expected = files.reduce((sum, file) => sum + selection.regularFileCases[file], 0)
  const reported = regular.testResults.map(
    file =>
      'tests/' +
      file.name
        .replaceAll('\\', '/')
        .split('/tests/')
        .at(-1)
        .replace(/^tests\//u, ''),
  )
  if (
    !regular.success ||
    regular.numFailedTests !== 0 ||
    regular.numPendingTests !== 0 ||
    regular.testResults.length !== files.length ||
    new Set(reported).size !== files.length ||
    reported.some(file => !files.includes(file)) ||
    regular.numPassedTests !== expected ||
    assertions.length !== expected ||
    regular.testResults.some((file, index) => file.assertionResults.length !== selection.regularFileCases[reported[index]]) ||
    assertions.some(row => row.status !== 'passed')
  ) {
    throw new Error('Every selected installed Linux case must run and pass')
  }
  return expected
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [regularPath, ...options] = process.argv.slice(2)
  const subset = options[0] === '--files' && options.length === 2 ? options[1].split(',') : undefined
  if (options.length && !subset) throw new Error('Expected --files with a comma-separated inventory subset')
  const expected = verifyRegular(JSON.parse(readFileSync(regularPath, 'utf8')), subset ?? selection.regular)
  console.log(`${expected} selected cases passed.`)
}
