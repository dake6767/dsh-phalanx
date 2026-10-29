import { BusinessRuleError } from './business-error.js'

/** A command and literal arguments, with shell-style quoting but no expansion or shell execution. */
export function executionCommandLine(line: string): readonly string[] {
  const invalid = () => new BusinessRuleError('invalid', 'Enter a command and literal arguments.', 'execution-config-invalid')
  if (typeof line !== 'string' || line.length > 8192 || /[\0\r\n]/u.test(line)) throw invalid()
  const words: string[] = []
  let word = '',
    quote = '',
    escaped = false,
    active = false
  for (const character of line) {
    if (escaped) {
      word += character
      escaped = false
      active = true
    } else if (character === '\\' && quote !== "'") {
      escaped = true
      active = true
    } else if (quote) {
      if (character === quote) quote = ''
      else word += character
    } else if (character === '"' || character === "'") {
      quote = character
      active = true
    } else if (/\s/u.test(character)) {
      if (active) {
        words.push(word)
        word = ''
        active = false
      }
    } else {
      word += character
      active = true
    }
  }
  if (quote || escaped) throw invalid()
  if (active) words.push(word)
  if (!words[0] || words.length > 256) throw invalid()
  return words
}

/** A PATH command or a skill-relative script; never an absolute or parent path. */
export const executionCommandPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 256 && /^(?:\.\/)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_][a-zA-Z0-9_.-]*)*$/u.test(value)

/** Long options protected by the administrator, including parser-supported abbreviations. */
export const executionLongOption = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 128 && /^--[a-zA-Z0-9][a-zA-Z0-9-]*$/u.test(value)
export function executionOptionBlocked(argv: readonly string[], blocked: readonly string[]): boolean {
  for (const argument of argv) {
    if (argument === '--') break
    const option = argument.split('=', 1)[0]!
    if (option.startsWith('--') && blocked.some(value => value.startsWith(option))) return true
  }
  return false
}
