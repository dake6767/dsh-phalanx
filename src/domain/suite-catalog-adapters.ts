import type { SuiteCatalogAdapterCall, SuiteCatalogRuntimeDependencyItem } from './suite-catalog-document.js'

/** Adapter names compiled into this platform version; the catalog cannot extend them. */
export const suiteCatalogAdapterNames = ['fixed-environment', 'refuse', 'credential-argument', 'normalize-arguments'] as const
export type SuiteCatalogAdapterName = typeof suiteCatalogAdapterNames[number]

export interface AdapterTarget { readonly item: string, readonly command: string }
export type ValidatedSuiteCatalogAdapter =
  | { readonly kind: 'fixed-environment', readonly target: AdapterTarget, readonly environment: Readonly<Record<string, string>> }
  | { readonly kind: 'refuse', readonly target: AdapterTarget, readonly arguments: readonly string[], readonly subcommands: readonly string[], readonly valueArguments: readonly string[], readonly message: string }
  | { readonly kind: 'credential-argument', readonly target: AdapterTarget, readonly variable: string, readonly argument: string }
  | { readonly kind: 'normalize-arguments', readonly target: AdapterTarget, readonly replacements: readonly { readonly from: string, readonly to: string }[], readonly valueArguments: readonly string[] }

export type SuiteCatalogAdapterFailureCode = 'unknown-adapter' | 'invalid-adapter-params'
export type SuiteCatalogAdapterValidation =
  | { readonly okay: true, readonly adapters: readonly ValidatedSuiteCatalogAdapter[] }
  | { readonly okay: false, readonly code: SuiteCatalogAdapterFailureCode, readonly detail: string }

const defaultRefusalMessage = 'This option is disabled by the platform.'
const variablePattern = /^[A-Z][A-Z0-9_]{0,63}$/u
const commandPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const argumentPattern = /^--?[A-Za-z0-9][A-Za-z0-9._:=+-]{0,127}$/u
const credentialFlagPattern = /^--[A-Za-z0-9][A-Za-z0-9._=-]{0,63}$/u
const flagTokenPattern = /^--?[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
/** Messages are written into a single-quoted shell word; printable ASCII without a quote or backslash is safe. */
const printable = /^[\x20-\x26\x28-\x5B\x5D-\x7E]{0,256}$/u

const failure = (code: SuiteCatalogAdapterFailureCode, detail: string): SuiteCatalogAdapterValidation => ({ okay: false, code, detail })
class AdapterParameterError extends Error {
  constructor(readonly detail: string) { super(detail); this.name = 'AdapterParameterError' }
}
/** Validates optional catalog text; invalid text rejects the entry through the validation wrapper. */
const readMessage = (value: unknown, fallback: string, detail: string): string => value === undefined ? fallback
  : typeof value === 'string' && printable.test(value) ? value : (() => { throw new AdapterParameterError(detail) })()
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const stringList = (value: unknown, check: (item: string) => boolean): readonly string[] | undefined =>
  Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every(item => typeof item === 'string' && check(item)) ? value as string[] : undefined

/**
 * Validates adapter calls against the entry's runtime items. Unknown names and invalid parameter contents reject
 * only this entry, so the rest of the document stays usable; malformed call shapes are structural document errors
 * and reject the whole document during parsing (spec decision 11). The same input always yields the same calls.
 */
export function validateSuiteCatalogAdapters(calls: readonly SuiteCatalogAdapterCall[], items: readonly SuiteCatalogRuntimeDependencyItem[]): SuiteCatalogAdapterValidation {
  try { return validateAdapters(calls, items) } catch (error) {
    if (error instanceof AdapterParameterError) return failure('invalid-adapter-params', error.detail)
    throw error
  }
}

function validateAdapters(calls: readonly SuiteCatalogAdapterCall[], items: readonly SuiteCatalogRuntimeDependencyItem[]): SuiteCatalogAdapterValidation {
  const runtime = new Map(items.filter(item => item.kind === 'runtime-dependency').map(item => [item.name, item]))
  const validated: ValidatedSuiteCatalogAdapter[] = []
  const seen = new Set<string>()
  for (const [index, call] of calls.entries()) {
    const adapter = (suiteCatalogAdapterNames as readonly string[]).includes(call.name) ? call.name as SuiteCatalogAdapterName : undefined
    if (adapter === undefined) return failure('unknown-adapter', `adapters[${index}]: ${call.name}`)
    const params = call.params
    const itemName = typeof params.item === 'string' ? params.item : undefined
    const command = typeof params.command === 'string' ? params.command : undefined
    const item = itemName === undefined ? undefined : runtime.get(itemName)
    if (!item || !itemName || !command) return failure('invalid-adapter-params', `${call.name} needs an existing item and command`)
    if (!item.commands.includes(command)) return failure('invalid-adapter-params', `${call.name}: ${item.name} does not provide ${command}`)
    if (!item.paths[0]) return failure('invalid-adapter-params', `${call.name}: ${item.name} has no PATH directory for the wrapper`)
    if (!item.runner) return failure('invalid-adapter-params', `${call.name}: ${item.name} declares no runner`)
    // The generated wrapper lives at <first PATH directory>/<command>. Refuse catalog data that would make the
    // platform write over a checksummed download or exec the wrapper itself.
    const wrapperPath = `${item.paths[0]}/${command}`
    if (item.downloads.some(download => download.target === wrapperPath)) return failure('invalid-adapter-params', `${call.name}: wrapper path ${wrapperPath} collides with a download target`)
    if (item.runner.path === wrapperPath) return failure('invalid-adapter-params', `${call.name}: wrapper path ${wrapperPath} collides with the runner path`)
    const entryPaths = item.entry === undefined ? [] : typeof item.entry === 'string' ? [item.entry] : Object.values(item.entry)
    if (entryPaths.includes(wrapperPath)) return failure('invalid-adapter-params', `${call.name}: wrapper path ${wrapperPath} collides with the entry path`)
    const target = { item: item.name, command }
    const key = `${adapter}\0${target.item}\0${target.command}`
    if (seen.has(key)) return failure('invalid-adapter-params', `${call.name}: duplicate call for ${target.item}/${target.command}`)
    seen.add(key)
    if (adapter === 'fixed-environment') {
      if (!isRecord(params.environment) || Object.keys(params.environment).length === 0 || Object.keys(params.environment).length > 32) return failure('invalid-adapter-params', `${call.name}: environment must map 1-32 names`)
      const environment: Record<string, string> = {}
      for (const [name, value] of Object.entries(params.environment)) {
        if (!variablePattern.test(name) || typeof value !== 'string' || !printable.test(value)) return failure('invalid-adapter-params', `${call.name}: invalid environment entry ${name}`)
        environment[name] = value
      }
      validated.push({ kind: 'fixed-environment', target, environment })
      continue
    }
    if (adapter === 'refuse') {
      const argumentsList = params.arguments === undefined ? [] : stringList(params.arguments, item => argumentPattern.test(item))
      const subcommands = params.subcommands === undefined ? [] : stringList(params.subcommands, item => commandPattern.test(item))
      if ((params.arguments !== undefined && argumentsList === undefined) || (params.subcommands !== undefined && subcommands === undefined)) return failure('invalid-adapter-params', `${call.name}: invalid refused argument list`)
      if (!argumentsList?.length && !subcommands?.length) return failure('invalid-adapter-params', `${call.name}: declare arguments or subcommands`)
      const notice = readMessage(params.message, defaultRefusalMessage, `${call.name}: invalid message`)
      // Flags known to consume the next token; subcommand scanning skips their value instead of treating it as a command.
      const valueArguments = params.valueArguments === undefined ? [] : stringList(params.valueArguments, item => argumentPattern.test(item))
      if (params.valueArguments !== undefined && valueArguments === undefined) return failure('invalid-adapter-params', `${call.name}: invalid value-argument list`)
      validated.push({ kind: 'refuse', target, arguments: argumentsList ?? [], subcommands: subcommands ?? [], valueArguments: valueArguments ?? [], message: notice })
      continue
    }
    if (adapter === 'normalize-arguments') {
      if (!Array.isArray(params.replacements) || params.replacements.length === 0 || params.replacements.length > 16) return failure('invalid-adapter-params', `${call.name}: replacements must list 1-16 mappings`)
      const valueArguments = params.valueArguments === undefined ? [] : stringList(params.valueArguments, item => flagTokenPattern.test(item))
      if (params.valueArguments !== undefined && valueArguments === undefined) return failure('invalid-adapter-params', `${call.name}: invalid value-argument list`)
      const replacements: { from: string, to: string }[] = []
      for (const [replacementIndex, row] of params.replacements.entries()) {
        if (!isRecord(row) || typeof row.from !== 'string' || typeof row.to !== 'string' || !flagTokenPattern.test(row.from) || !flagTokenPattern.test(row.to)) return failure('invalid-adapter-params', `${call.name}: invalid replacement ${replacementIndex}`)
        if (row.from === row.to) return failure('invalid-adapter-params', `${call.name}: replacement ${row.from} maps to itself`)
        if (replacements.some(existing => existing.from === row.from)) return failure('invalid-adapter-params', `${call.name}: duplicate replacement ${row.from}`)
        if (valueArguments?.includes(row.from)) return failure('invalid-adapter-params', `${call.name}: ${row.from} both takes a value and is rewritten`)
        replacements.push({ from: row.from, to: row.to })
      }
      validated.push({ kind: 'normalize-arguments', target, replacements, valueArguments: valueArguments ?? [] })
      continue
    }
    if (typeof params.variable !== 'string' || !variablePattern.test(params.variable)) return failure('invalid-adapter-params', `${call.name}: invalid variable name`)
    if (typeof params.argument !== 'string' || !credentialFlagPattern.test(params.argument)) return failure('invalid-adapter-params', `${call.name}: invalid command-line argument`)
    if (params.position !== undefined && params.position !== 'append') return failure('invalid-adapter-params', `${call.name}: only append is supported`)
    validated.push({ kind: 'credential-argument', target, variable: params.variable, argument: params.argument })
  }
  return { okay: true, adapters: validated }
}

const quotePrintf = (line: string): string => `'${line.replaceAll("'", `'\\''`)}'`
const shellArgument = (argument: string): string => argumentPattern.test(argument) ? argument : `'${argument.replaceAll("'", `'\\''`)}'`

/** Relative path from the wrapper in the first PATH directory back to the artifact root. */
// The wrapper sits at <pathDirectory>/<command>; validation rejects trailing slashes and `.`/`..` segments,
// so one `..` per declared segment resolves exactly to the preparation root.
const rootPrefix = (pathDirectory: string): string => `${'../'.repeat(pathDirectory.split('/').length)}`

function execLine(item: SuiteCatalogRuntimeDependencyItem): string {
  const runner = item.runner
  if (!runner) throw new Error(`Item ${item.name} declares no runner`)
  const root = `"$(dirname "$(readlink -f "$0")")/${rootPrefix(item.paths[0]!)}${runner.path ?? ''}"`
  const fixed = runner.args?.length ? ` ${runner.args.map(shellArgument).join(' ')}` : ''
  if (runner.path === undefined) return `exec ${runner.command}${fixed} "$@"`
  if (runner.command === undefined) return `exec ${root}${fixed} "$@"`
  return `exec ${runner.command} ${root}${fixed} "$@"`
}

/**
 * The wrapper body for one command, in fixed order: refusal on the original user arguments, exact-token argument
 * normalization, credential appending, fixed environment, then exec. `exec node` resolves Node from the member PATH;
 * the platform base image ships Node (the 0.1.18 wrappers used a Node shebang/process.execPath equivalently).
 */
export function adapterWrapperLines(item: SuiteCatalogRuntimeDependencyItem, adapters: readonly ValidatedSuiteCatalogAdapter[]): readonly string[] {
  const lines: string[] = ['#!/bin/sh']
  const refuse = adapters.find(adapter => adapter.kind === 'refuse')
  if (refuse) {
    const message = `printf '%s\\n' ${quotePrintf(refuse.message)} >&2`
    if (refuse.arguments.length) {
      const patterns = refuse.arguments.flatMap(argument => [`${argument}`, `${argument}=*`]).join('|')
      lines.push(`for arg in "$@"; do case "$arg" in --) break;; ${patterns}) ${message}; exit 2;; esac; done`)
    }
    if (refuse.subcommands.length) {
      // Only the first positional token is a subcommand; known value-taking flags skip their value,
      // so `tool --output x update` is still refused while `tool --output update` is not.
      lines.push('skip=0')
      lines.push('for arg in "$@"; do')
      lines.push('  if [ "$skip" = 1 ]; then skip=0; continue; fi')
      lines.push('  case "$arg" in')
      if (refuse.valueArguments.length) lines.push(`    ${refuse.valueArguments.join('|')}) skip=1 ;;`)
      lines.push('    --) break ;;')
      lines.push('    -*) ;;')
      lines.push(`    ${refuse.subcommands.join('|')}) ${message}; exit 2 ;;`)
      lines.push('    *) break ;;')
      lines.push('  esac')
      lines.push('done')
    }
  }
  const normalize = adapters.find(adapter => adapter.kind === 'normalize-arguments')
  if (normalize) {
    // Exact standalone-token replacement: values of known value-taking flags, inline values (`--flag=value`) and
    // everything after `--` pass through untouched; the remaining argument order is preserved.
    lines.push('count=$#', 'normalizing=1', 'expect_value=0', 'while [ "$count" -gt 0 ]; do', '  arg=$1; shift; count=$((count - 1))',
      '  if [ "$expect_value" = 1 ]; then set -- "$@" "$arg"; expect_value=0; continue; fi', '  if [ "$normalizing" = 1 ]; then', '    case "$arg" in',
      '      --) normalizing=0 ;;')
    if (normalize.valueArguments.length) lines.push(`      ${normalize.valueArguments.join('|')}) expect_value=1 ;;`)
    for (const replacement of normalize.replacements) lines.push(`      ${replacement.from}) arg=${replacement.to} ;;`)
    lines.push('    esac', '  fi', '  set -- "$@" "$arg"', 'done')
  }
  const credential = adapters.find(adapter => adapter.kind === 'credential-argument')
  if (credential) {
    // Insert before the first `--` so the credential stays an option even with more than one separator;
    // with no `--` it appends like 0.1.18 did.
    const value = `$${credential.variable}`
    lines.push(`if [ -n "\${${credential.variable}:-}" ]; then`,
      '  first=0; position=0',
      '  for arg in "$@"; do position=$((position + 1)); [ "$arg" = "--" ] && { first=$position; break; }; done',
      '  count=$#; seen=0',
      '  while [ "$count" -gt 0 ]; do',
      '    arg=$1; shift; count=$((count - 1)); seen=$((seen + 1))',
      `    if [ "$seen" -eq "$first" ]; then set -- "$@" ${credential.argument} "${value}"; fi`,
      '    set -- "$@" "$arg"',
      '  done',
      `  if [ "$first" -eq 0 ]; then set -- "$@" ${credential.argument} "${value}"; fi`,
      'fi')
  }
  const fixed = adapters.find(adapter => adapter.kind === 'fixed-environment')
  if (fixed) for (const [name, value] of Object.entries(fixed.environment)) lines.push(`export ${name}=${shellValue(value)}`)
  lines.push(execLine(item))
  return lines
}

/** Values matching this token pattern can be exported unquoted; everything else is single-quoted (validated data). */
const shellValue = (value: string): string => /^[A-Za-z0-9._:/@+-]*$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`

export interface AdapterWrapper {
  readonly item: string
  readonly command: string
  readonly path: string
  readonly lines: readonly string[]
}

/** Deterministic wrapper list: commands keep the item's declared order, one wrapper per wrapped command. */
export function suiteCatalogAdapterWrappers(item: SuiteCatalogRuntimeDependencyItem, adapters: readonly ValidatedSuiteCatalogAdapter[]): readonly AdapterWrapper[] {
  const targetAdapters = adapters.filter(adapter => adapter.target.item === item.name)
  return item.commands.flatMap(command => {
    const forCommand = targetAdapters.filter(adapter => adapter.target.command === command)
    return forCommand.length ? [{ item: item.name, command, path: `${item.paths[0]}/${command}`, lines: adapterWrapperLines(item, forCommand) }] : []
  })
}

/** Preparation steps that write and chmod each generated wrapper, keeping shell data quoted as printf arguments. */
export function adapterWrapperSteps(item: SuiteCatalogRuntimeDependencyItem, adapters: readonly ValidatedSuiteCatalogAdapter[]): readonly string[] {
  return suiteCatalogAdapterWrappers(item, adapters).flatMap(wrapper => [
    `printf '%s\\n' ${wrapper.lines.map(quotePrintf).join(' ')} > ${wrapper.path}`,
    `chmod +x ${wrapper.path}`,
  ])
}
