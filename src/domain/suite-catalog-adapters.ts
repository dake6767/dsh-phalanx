import type { SuiteCatalogAdapterCall, SuiteCatalogRuntimeDependencyItem } from './suite-catalog-document.js'

/** Adapter names compiled into this platform version; the catalog cannot extend them. */
export const suiteCatalogAdapterNames = ['fixed-environment', 'refuse', 'credential-argument'] as const
export type SuiteCatalogAdapterName = typeof suiteCatalogAdapterNames[number]

export interface AdapterTarget { readonly item: string, readonly command: string }
export type ValidatedSuiteCatalogAdapter =
  | { readonly kind: 'fixed-environment', readonly target: AdapterTarget, readonly environment: Readonly<Record<string, string>> }
  | { readonly kind: 'refuse', readonly target: AdapterTarget, readonly arguments: readonly string[], readonly subcommands: readonly string[], readonly message: string }
  | { readonly kind: 'credential-argument', readonly target: AdapterTarget, readonly variable: string, readonly argument: string }

export type SuiteCatalogAdapterFailureCode = 'unknown-adapter' | 'invalid-adapter-params'
export type SuiteCatalogAdapterValidation =
  | { readonly okay: true, readonly adapters: readonly ValidatedSuiteCatalogAdapter[] }
  | { readonly okay: false, readonly code: SuiteCatalogAdapterFailureCode, readonly detail: string }

const defaultRefusalMessage = 'This option is disabled by the platform.'
const variablePattern = /^[A-Z][A-Z0-9_]{0,63}$/u
const commandPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const argumentPattern = /^--?[A-Za-z0-9][A-Za-z0-9._:=+-]{0,127}$/u
const credentialFlagPattern = /^--[A-Za-z0-9][A-Za-z0-9._=-]{0,63}$/u
/** Messages are written into a single-quoted shell word; printable ASCII without a quote or backslash is safe. */
const printable = /^[\x20-\x26\x28-\x5B\x5D-\x7E]{0,256}$/u

const failure = (code: SuiteCatalogAdapterFailureCode, detail: string): SuiteCatalogAdapterValidation => ({ okay: false, code, detail })
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const stringList = (value: unknown, check: (item: string) => boolean): readonly string[] | undefined =>
  Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every(item => typeof item === 'string' && check(item)) ? value as string[] : undefined

/**
 * Validates adapter calls against the entry's runtime items. Unknown names and invalid parameters reject only
 * this entry; the rest of the document stays usable. The same input always yields the same validated calls.
 */
export function validateSuiteCatalogAdapters(calls: readonly SuiteCatalogAdapterCall[], items: readonly SuiteCatalogRuntimeDependencyItem[]): SuiteCatalogAdapterValidation {
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
      const message = params.message === undefined ? defaultRefusalMessage : (typeof params.message === 'string' && printable.test(params.message) ? params.message : undefined)
      if (message === undefined) return failure('invalid-adapter-params', `${call.name}: invalid message`)
      validated.push({ kind: 'refuse', target, arguments: argumentsList ?? [], subcommands: subcommands ?? [], message })
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

/** The wrapper body for one command: refusal first, then credential appending, then fixed environment, then exec. */
export function adapterWrapperLines(item: SuiteCatalogRuntimeDependencyItem, adapters: readonly ValidatedSuiteCatalogAdapter[]): readonly string[] {
  const lines: string[] = ['#!/bin/sh']
  const refuse = adapters.find(adapter => adapter.kind === 'refuse')
  if (refuse) {
    const message = `echo ${quotePrintf(refuse.message)} >&2`
    if (refuse.arguments.length) {
      const patterns = refuse.arguments.flatMap(argument => [`${argument}`, `${argument}=*`]).join('|')
      lines.push(`for arg in "$@"; do case "$arg" in ${patterns}) ${message}; exit 2;; esac; done`)
    }
    if (refuse.subcommands.length) lines.push(`for arg in "$@"; do case "$arg" in -*) ;; ${refuse.subcommands.join('|')}) ${message}; exit 2;; *) break;; esac; done`)
  }
  const credential = adapters.find(adapter => adapter.kind === 'credential-argument')
  if (credential) lines.push(`if [ -n "\${${credential.variable}:-}" ]; then set -- "$@" ${credential.argument} "\$${credential.variable}"; fi`)
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
