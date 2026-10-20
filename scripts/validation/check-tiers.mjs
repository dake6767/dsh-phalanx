import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const selection = JSON.parse(readFileSync('scripts/validation/t2-selection.json', 'utf8'))
const files = readdirSync('tests', { recursive: true }).filter(file => file.endsWith('.e2e.ts')).map(file => join('tests', file))
for (const file of files) {
  const declaration = readFileSync(file, 'utf8').split('\n')[0]
  if (!/^\/\/ Validation: T[1-4].*; real credentials: (none|required|SSH|.*NEWS_KEY_FILE)/.test(declaration)) {
    throw new Error(`${file} must declare its validation tier and real credential requirements on the first line`)
  }
  if (selection.regular.includes(file) && !declaration.startsWith('// Validation: T2; real credentials: none;')) {
    throw new Error(`${file} is selected by T2 but is not declared credential-free`)
  }
}
if (selection.regular.length !== 56 || new Set(selection.regular).size !== 56 ||
    selection.regular.reduce((sum, file) => sum + selection.regularFileCases[file], 0) !== selection.regularCases ||
    selection.regular.some(file => !files.includes(file)) || !files.includes(selection.migration.file) ||
    selection.smoke.some(file => !selection.regular.includes(file))) {
  throw new Error('The approved T2 selection is missing, duplicated or inconsistent')
}
const upgrade = selection.formalUpgrade?.file
if (!files.includes(upgrade) || selection.regular.includes(upgrade) ||
    !readFileSync(upgrade, 'utf8').split('\n')[0].startsWith('// Validation: T2 formal upgrade job; real credentials: none;')) {
  throw new Error('The T2 formal upgrade case must be a credential-free file outside the regular selection')
}
console.log(`${files.length} e2e files declare tiers and credentials; T2 selects 56 regular files, one named migration case and the separate formal upgrade case.`)
