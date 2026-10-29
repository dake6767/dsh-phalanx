import { executionCommandPath, executionLongOption } from './execution-command-line.js'
import { readCatalogPluginItem } from './suite-plugin.js'
import { pythonPackagePins } from './python-library.js'
import { createHash } from 'node:crypto'
import { isStrictSemver, parseSemverRange } from './semver.js'

/** Signed online catalog: data-only entries plus the platform-generated preparation. */
export const suiteCatalogFormat = 1
export type SuiteCatalogLocale = 'en' | 'zh-CN'
export type SuiteCatalogLocalized = Readonly<Record<SuiteCatalogLocale, string>>
export type SuiteCatalogArch = 'amd64' | 'arm64'
/** A value that differs per deployment architecture; a missing key means unsupported there. */
export type SuiteCatalogArchValue = Readonly<Partial<Record<SuiteCatalogArch, string>>>
/** Download-source classes a declarative download may use; the platform owns the prefix variable. */
export type SuiteCatalogDownloadSource = 'github-assets' | 'browser' | 'npm' | 'pypi'
export type SuiteCatalogEntryKind = 'suite' | 'dependency' | 'mcp' | 'skill' | 'plugin'

/**
 * A wrapper behavior the catalog references by name. Parameters are pure data; the platform renders the wrapper.
 * Unknown names and invalid parameters are single-entry rejections, not document rejections.
 */
export interface SuiteCatalogAdapterCall {
  readonly name: string
  readonly params: Readonly<Record<string, unknown>>
}
/** The real entry a generated wrapper executes: a PATH command, an artifact file, or a command taking the artifact file. */
export interface SuiteCatalogRunner {
  /** Command resolved on the platform PATH, e.g. node. */
  readonly command?: string
  /** Executable path relative to the artifact root. */
  readonly path?: string
  /** Fixed arguments placed before the caller's arguments. */
  readonly args?: readonly string[]
}

export interface SuiteCatalogDownload {
  readonly source: SuiteCatalogDownloadSource
  /** github-assets: absolute upstream URL; browser: path under the browser host. Both accept `{arch}` and `{nodeArch}`. */
  readonly url?: string | SuiteCatalogArchValue
  /** npm/PyPI package specs; `{nodeArch}` is replaced by x64/arm64. */
  readonly packages?: readonly string[]
  /** Per-architecture sha256 of the fetched file; required for every github-assets and browser download. */
  readonly sha256?: SuiteCatalogArchValue
  /** File written under the artifact root; directory parts are created first. */
  readonly target?: string
  /** Archive handling after the checksum was verified. */
  readonly extract?: { readonly format: 'none' | 'tar' | 'zip'; readonly directory?: string; readonly stripComponents?: number; readonly member?: string }
  /** Mark the fetched file executable. */
  readonly executable?: boolean
  /** Explicit curl timeouts; omitted keeps the platform default (no timeout flags). */
  readonly timeout?: { readonly connectSeconds?: number; readonly totalSeconds?: number }
}

export interface SuiteCatalogRuntimeDependencyItem {
  readonly kind: 'runtime-dependency'
  readonly type?: 'python-library' | 'resource'
  /** Architectures whose complete package lock has wheels for the platform Python. */
  readonly architectures?: readonly SuiteCatalogArch[]
  readonly name: string
  /** PATH directories the artifact publishes. */
  readonly paths: readonly string[]
  /** Entry commands the artifact provides. */
  readonly commands: readonly string[]
  /** Executable readiness check; arguments stay data, never a shell script. */
  readonly check?: { readonly command: string; readonly args?: readonly string[] }
  readonly downloads: readonly SuiteCatalogDownload[]
  /** Symlink entry under the first PATH directory; relative to the artifact root, per architecture. */
  readonly entry?: string | SuiteCatalogArchValue
  /** Real entry the adapter-generated wrappers execute; required when adapters wrap one of this item's commands. */
  readonly runner?: SuiteCatalogRunner
}
export interface SuiteCatalogSkillItem {
  readonly kind: 'skill'
  readonly source: { readonly type: 'git'; readonly url: string; readonly commit: string; readonly path: string }
  readonly names: readonly string[]
  readonly runtimeDependency?: string
  readonly catalogDependencies?: readonly string[]
}
export interface SuiteCatalogSkillPackItem {
  readonly kind: 'skill-pack'
  readonly name: string
  readonly description: string
  readonly note: string
  readonly skills: readonly string[]
}
export interface SuiteCatalogExecutionItem {
  readonly kind: 'execution'
  readonly skill: string
  readonly runtimeDependency: string
  readonly delegated: readonly {
    readonly command: string
    readonly source?: string
    readonly memberPath?: string
    readonly blockedOptions?: readonly string[]
    readonly blocked: readonly string[]
  }[]
  readonly variables: readonly { readonly name: string; readonly optional?: boolean; readonly purpose: Readonly<Record<'en' | 'zh-CN', string>> }[]
}
export type SuiteCatalogItem =
  | import('./suite-catalog.js').SuiteCatalogPluginItem
  | SuiteCatalogRuntimeDependencyItem
  | SuiteCatalogSkillItem
  | SuiteCatalogSkillPackItem
  | SuiteCatalogExecutionItem

export interface SuiteCatalogDocumentEntryBase {
  readonly kind: SuiteCatalogEntryKind
  readonly id: string
  /** Strict SemVer; the same id and version identify immutable content. */
  readonly version: string
  readonly engines: { readonly platform: string }
  /** sha256 of this entry's canonical content, without this field. */
  readonly contentHash: string
  /** Wrapper behaviors rendered by the platform; each call names a built-in adapter and carries pure data. */
  readonly adapters: readonly SuiteCatalogAdapterCall[]
  readonly title: SuiteCatalogLocalized
  readonly description: SuiteCatalogLocalized
  readonly source: SuiteCatalogLocalized
}
export interface SuiteCatalogDocumentDependencyEntry extends SuiteCatalogDocumentEntryBase {
  readonly kind: 'dependency'
  readonly items: readonly SuiteCatalogItem[]
}
export interface SuiteCatalogDocumentSuiteEntry extends SuiteCatalogDocumentEntryBase {
  readonly kind: 'suite' | 'plugin'
  readonly identity: SuiteCatalogLocalized
  readonly dependencies: readonly string[]
  /** External services the suite reaches at runtime; adapters may only use addresses listed here. */
  readonly serviceAddresses?: readonly string[]
  readonly items: readonly SuiteCatalogItem[]
}
/** Kinds reserved by the outer format and skipped by this version. */
export interface SuiteCatalogDocumentReservedEntry extends SuiteCatalogDocumentEntryBase {
  readonly kind: 'mcp' | 'skill'
}
export type SuiteCatalogDocumentEntry = SuiteCatalogDocumentDependencyEntry | SuiteCatalogDocumentSuiteEntry | SuiteCatalogDocumentReservedEntry
export interface SuiteCatalogDocument {
  readonly format: typeof suiteCatalogFormat
  readonly publishedAt: string
  readonly entries: readonly SuiteCatalogDocumentEntry[]
  readonly signature: { readonly keyId: string; readonly signature: string }
}

export type SuiteCatalogDocumentRejection = 'invalid-json' | 'invalid-structure' | 'unsupported-format'

/** Deterministic JSON: recursively sorted object keys, array order preserved, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  throw new TypeError('Canonical JSON only accepts JSON values')
}

/**
 * Bytes signed by Ed25519: the canonical form of the JSON object as received, minus the top-level signature.
 * Unknown members stay in the payload, so publishers sign what they wrote and later readers ignore them.
 */
export function suiteCatalogSignedPayload(document: object): Buffer {
  const { signature, ...rest } = document as Record<string, unknown>
  void signature
  return Buffer.from(canonicalJson(rest), 'utf8')
}

/** Content hash of one entry: canonical form of the received entry object minus the hash itself. */
export function suiteCatalogContentHash(entry: object): string {
  const { contentHash, ...rest } = entry as Record<string, unknown>
  void contentHash
  return createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex')
}

/** The catalog repository seals each entry with its own content hash before signing the document. */
export type UnsealedSuiteCatalogDocumentEntry =
  | Omit<SuiteCatalogDocumentDependencyEntry, 'contentHash'>
  | Omit<SuiteCatalogDocumentSuiteEntry, 'contentHash'>
  | Omit<SuiteCatalogDocumentReservedEntry, 'contentHash'>
/** Validates one entry and returns it normalized (unknown fields dropped); throws on invalid structure. */
export function normalizeSuiteCatalogDocumentEntry(value: unknown): SuiteCatalogDocumentEntry {
  try {
    return readEntry(value, 0)
  } catch (error) {
    if (error instanceof InvalidStructure) throw new Error(`Invalid catalog entry: ${error.message}`)
    throw error
  }
}
export function withSuiteCatalogContentHash(entry: UnsealedSuiteCatalogDocumentEntry): SuiteCatalogDocumentEntry {
  // Validate known fields, but never normalize the published bytes: unknown fields are signed and hashed as written.
  normalizeSuiteCatalogDocumentEntry({ ...entry, contentHash: '0'.repeat(64) })
  return { ...entry, contentHash: suiteCatalogContentHash(entry) } as SuiteCatalogDocumentEntry
}

export type SuiteCatalogDocumentRead =
  | { readonly okay: true; readonly raw: Record<string, unknown>; readonly document: SuiteCatalogDocument }
  | { readonly okay: false; readonly rejection: SuiteCatalogDocumentRejection; readonly detail?: string }

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const argPattern = /^[A-Za-z0-9._:/=@+-]{0,256}$/u
const hashPattern = /^[0-9a-f]{64}$/u
const commitPattern = /^[0-9a-f]{40}$/u
// Relative paths only: no empty segments, no `.`/`..` segments and no trailing slash, so a wrapper can resolve
// the preparation root with one `..` per declared path segment.
const pathPattern = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._@/-]{1,512}$/u
// Package specs are interpolated unquoted into the registry command; the version may only use characters that are
// shell-inert there. Ranges, wildcards and comparison operators are rejected structurally (and again by the checks).
const npmPackagePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,127}(?:@[A-Za-z0-9._+-]{1,64})?$/u
const pypiPackagePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:==[A-Za-z0-9._+-]{1,64})?$/u
// Download URLs are interpolated inside double quotes in platform-generated commands. The allowed set is
// shell-safe there (no $, backticks, quotes, backslash, redirection, pipe or whitespace); placeholders are
// substituted before validation so no other braces can reach the generated command.
const downloadUrlPattern = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~:/?#@!&'*+,=%[\]-]*$/u
const browserPathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._~:/?#@!&'*+,=%[\]-]+$/u
const archTokenPattern = /\{(?:arch|nodeArch)\}/gu
const adapterNamePattern = /^[a-z][a-z0-9-]{0,63}$/u

class InvalidStructure extends Error {}
const fail = (detail: string): never => {
  throw new InvalidStructure(detail)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const text = (value: unknown, detail: string): string => (nonEmpty(value) && value.length <= 4096 && !value.includes('\0') ? value : fail(detail))
const optionalText = (value: unknown, detail: string): string | undefined => (value === undefined ? undefined : text(value, detail))
const safePath = (value: unknown, detail: string): string => (typeof value === 'string' && value.length > 0 && pathPattern.test(value) ? value : fail(detail))
const stringList = (value: unknown, detail: string, check: (item: string) => boolean = () => true): readonly string[] => {
  if (!Array.isArray(value) || value.length > 512 || value.some(item => typeof item !== 'string' || !check(item))) return fail(detail)
  return value as string[]
}
const localized = (value: unknown, detail: string): SuiteCatalogLocalized => {
  if (!isRecord(value)) return fail(detail)
  return { en: text(value.en, detail), 'zh-CN': text(value['zh-CN'], detail) }
}
const archValue = (value: unknown, detail: string, check: (item: string) => boolean = () => true): SuiteCatalogArchValue => {
  if (!isRecord(value)) return fail(detail)
  const result: Partial<Record<SuiteCatalogArch, string>> = {}
  for (const key of Object.keys(value)) {
    if (key !== 'amd64' && key !== 'arm64') return fail(detail)
    const item = value[key]
    if (typeof item !== 'string' || !check(item)) return fail(detail)
    result[key] = item
  }
  if (!result.amd64 && !result.arm64) return fail(detail)
  return result
}

/** JSON parse only; the signature is verified over this object before any field is normalized or trusted. */
export function parseSuiteCatalogJson(
  bytes: Uint8Array,
):
  | { readonly okay: true; readonly raw: Record<string, unknown> }
  | { readonly okay: false; readonly rejection: SuiteCatalogDocumentRejection; readonly detail?: string } {
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return { okay: false, rejection: 'invalid-json' }
  }
  if (!isRecord(raw)) return { okay: false, rejection: 'invalid-structure', detail: 'document' }
  return { okay: true, raw }
}

/** Structural validation and normalization of an already parsed document; unknown fields are dropped here. */
export function normalizeSuiteCatalogDocument(raw: unknown): SuiteCatalogDocumentRead {
  try {
    if (!isRecord(raw)) return fail('document')
    if (raw.format !== suiteCatalogFormat) return { okay: false, rejection: 'unsupported-format', detail: `format ${String(raw.format)}` }
    const publishedAt = text(raw.publishedAt, 'publishedAt')
    if (Number.isNaN(Date.parse(publishedAt))) return fail('publishedAt')
    if (!isRecord(raw.signature)) return fail('signature')
    const signature = { keyId: text(raw.signature.keyId, 'signature.keyId'), signature: text(raw.signature.signature, 'signature.signature') }
    if (!Array.isArray(raw.entries) || raw.entries.length > 1024) return fail('entries')
    const entries = raw.entries.map((entry, index) => readEntry(entry, index))
    // One id names one entry in a document; versions are carried per entry, and immutability is keyed by id+version.
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) return fail('entries: duplicate id')
    return { okay: true, raw, document: { format: suiteCatalogFormat, publishedAt, entries, signature } }
  } catch (error) {
    if (error instanceof InvalidStructure) return { okay: false, rejection: 'invalid-structure', detail: error.message }
    throw error
  }
}

function readEntry(value: unknown, index: number): SuiteCatalogDocumentEntry {
  const where = `entries[${index}]`
  if (!isRecord(value)) return fail(where)
  const kind = value.kind
  if (typeof kind !== 'string' || !['suite', 'dependency', 'mcp', 'skill', 'plugin'].includes(kind)) return fail(`${where}.kind`)
  const id = typeof value.id === 'string' && idPattern.test(value.id) ? value.id : fail(`${where}.id`)
  if (typeof value.version !== 'string' || !isStrictSemver(value.version)) return fail(`${where}.version`)
  if (!isRecord(value.engines) || typeof value.engines.platform !== 'string' || !parseSemverRange(value.engines.platform)) return fail(`${where}.engines`)
  const engines = { platform: value.engines.platform }
  if (typeof value.contentHash !== 'string' || !hashPattern.test(value.contentHash)) return fail(`${where}.contentHash`)
  const adapters = readAdapterCalls(value.adapters, `${where}.adapters`)
  const base: SuiteCatalogDocumentEntryBase = {
    kind: kind as SuiteCatalogEntryKind,
    id,
    version: value.version,
    engines,
    contentHash: value.contentHash,
    adapters,
    title: localized(value.title, `${where}.title`),
    description: localized(value.description, `${where}.description`),
    source: localized(value.source, `${where}.source`),
  }
  if (kind === 'suite' || kind === 'plugin') {
    const identity = kind === 'plugin' ? base.title : localized(value.identity, `${where}.identity`)
    const dependencies = stringList(value.dependencies, `${where}.dependencies`, item => idPattern.test(item))
    const serviceAddresses = value.serviceAddresses === undefined ? [] : stringList(value.serviceAddresses, `${where}.serviceAddresses`, serviceAddress)
    if (!Array.isArray(value.items) || value.items.length > 512) return fail(`${where}.items`)
    return { ...base, kind, identity, dependencies, serviceAddresses, items: value.items.map(readItem) }
  }
  if (kind === 'dependency') {
    if (!Array.isArray(value.items) || value.items.length === 0) return fail(`${where}.items`)
    return { ...base, kind, items: value.items.map(readItem) }
  }
  return { ...base, kind: kind as 'mcp' | 'skill' }
}

function serviceAddress(value: string): boolean {
  if (value.length > 2048) return false
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

function readAdapterCalls(value: unknown, detail: string): readonly SuiteCatalogAdapterCall[] {
  if (!Array.isArray(value) || value.length > 16) return fail(detail)
  return value.map((call, index) => {
    if (!isRecord(call)) return fail(`${detail}[${index}]`)
    const name = typeof call.name === 'string' && adapterNamePattern.test(call.name) ? call.name : fail(`${detail}[${index}].name`)
    // Parameter contents are validated by the named adapter so an unknown or malformed call rejects only this entry.
    if (!isRecord(call.params)) return fail(`${detail}[${index}].params`)
    return { name, params: call.params }
  })
}

function readRunner(value: unknown, detail: string): SuiteCatalogRunner {
  if (!isRecord(value)) return fail(detail)
  const command =
    value.command === undefined ? undefined : typeof value.command === 'string' && namePattern.test(value.command) ? value.command : fail(`${detail}.command`)
  const path = value.path === undefined ? undefined : safePath(value.path, `${detail}.path`)
  // `command` alone runs a PATH command; `path` alone execs the artifact file; both pass the file to the command (node <file>).
  if (command === undefined && path === undefined) return fail(`${detail}: command or path is required`)
  const args = value.args === undefined ? undefined : stringList(value.args, `${detail}.args`, item => argPattern.test(item))
  return { ...(command ? { command } : {}), ...(path ? { path } : {}), ...(args ? { args } : {}) }
}

function readItem(value: unknown): SuiteCatalogItem {
  if (!isRecord(value)) return fail('item')
  const kind = value.kind
  if (kind === 'plugin') {
    try {
      return readCatalogPluginItem(value)
    } catch {
      return fail('plugin')
    }
  }
  if (kind === 'runtime-dependency') {
    const name = text(value.name, 'runtime-dependency.name')
    if (!Array.isArray(value.paths) || value.paths.length > 16) return fail('runtime-dependency.paths')
    const paths = value.paths.map(path => safePath(path, 'runtime-dependency.paths'))
    const commands = stringList(value.commands, 'runtime-dependency.commands', item => namePattern.test(item))
    if (commands.length === 0 && value.type !== 'resource') return fail('runtime-dependency.commands')
    const check = value.check === undefined ? undefined : readCheck(value.check)
    if (!Array.isArray(value.downloads) || value.downloads.length === 0 || value.downloads.length > 256) return fail('runtime-dependency.downloads')
    const downloads = value.downloads.map(readDownload)
    const entry =
      typeof value.entry === 'string'
        ? safePath(value.entry, 'runtime-dependency.entry')
        : value.entry === undefined
          ? undefined
          : archValue(value.entry, 'runtime-dependency.entry', item => pathPattern.test(item))
    const runner = value.runner === undefined ? undefined : readRunner(value.runner, 'runtime-dependency.runner')
    let python: { type: 'python-library'; architectures: readonly SuiteCatalogArch[] } | undefined
    if (value.type === 'python-library') {
      const architectures = stringList(
        value.architectures,
        'runtime-dependency.architectures',
        arch => arch === 'amd64' || arch === 'arm64',
      ) as readonly SuiteCatalogArch[]
      if (
        !architectures.length ||
        new Set(architectures).size !== architectures.length ||
        paths.join('\0') !== 'venv/bin' ||
        commands.join('\0') !== 'python3' ||
        entry ||
        runner ||
        check ||
        downloads.some(download => download.source !== 'pypi') ||
        !pythonPackagePins(downloads.flatMap(download => download.packages ?? []))
      )
        return fail('runtime-dependency.python-library')
      python = { type: 'python-library', architectures }
    }
    if (value.type === 'resource' && (paths.length || commands.length || entry || runner)) return fail('runtime-dependency.resource')
    return {
      kind,
      name,
      paths,
      commands,
      ...(value.type === 'resource' ? { type: 'resource' as const } : python),
      ...(check ? { check } : {}),
      downloads,
      ...(entry ? { entry } : {}),
      ...(runner ? { runner } : {}),
    }
  }
  if (kind === 'skill') {
    if (!isRecord(value.source)) return fail('skill.source')
    const source = {
      type: 'git' as const,
      url: text(value.source.url, 'skill.source.url'),
      commit: typeof value.source.commit === 'string' && commitPattern.test(value.source.commit) ? value.source.commit : fail('skill.source.commit'),
      path: safePath(value.source.path, 'skill.source.path'),
    }
    if (!/^https:\/\//u.test(source.url)) return fail('skill.source.url')
    const names = stringList(value.names, 'skill.names', item => namePattern.test(item))
    if (names.length === 0) return fail('skill.names')
    const runtimeDependency = optionalText(value.runtimeDependency, 'skill.runtimeDependency')
    const catalogDependencies =
      value.catalogDependencies === undefined ? undefined : stringList(value.catalogDependencies, 'skill.catalogDependencies', item => idPattern.test(item))
    return { kind, source, names, ...(runtimeDependency ? { runtimeDependency } : {}), ...(catalogDependencies ? { catalogDependencies } : {}) }
  }
  if (kind === 'skill-pack') {
    return {
      kind,
      name: namePattern.test(text(value.name, 'skill-pack.name')) ? (value.name as string) : fail('skill-pack.name'),
      description: text(value.description, 'skill-pack.description'),
      note: text(value.note, 'skill-pack.note'),
      skills: stringList(value.skills, 'skill-pack.skills', item => namePattern.test(item)),
    }
  }
  if (kind === 'execution') {
    const skill = text(value.skill, 'execution.skill'),
      runtimeDependency = text(value.runtimeDependency, 'execution.runtimeDependency')
    if (!Array.isArray(value.delegated)) return fail('execution.delegated')
    const delegated = value.delegated.map(row => {
      if (!isRecord(row)) return fail('execution.delegated')
      return {
        command: executionCommandPath(row.command) ? row.command : fail('execution.delegated.command'),
        ...(row.source === undefined
          ? {}
          : { source: executionCommandPath(row.source) && row.source.includes('/') ? row.source : fail('execution.delegated.source') }),
        ...(row.memberPath === undefined
          ? {}
          : {
              memberPath:
                row.source && executionCommandPath(row.memberPath) && row.memberPath.includes('/') ? row.memberPath : fail('execution.delegated.memberPath'),
            }),
        ...(row.blockedOptions === undefined
          ? {}
          : { blockedOptions: stringList(row.blockedOptions, 'execution.delegated.blockedOptions', executionLongOption) }),
        blocked: stringList(row.blocked, 'execution.delegated.blocked', item => namePattern.test(item)),
      }
    })
    if (!Array.isArray(value.variables)) return fail('execution.variables')
    const variables = value.variables.map(row => {
      if (!isRecord(row)) return fail('execution.variables')
      const name = text(row.name, 'execution.variables.name')
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name)) return fail('execution.variables.name')
      if (row.optional !== undefined && typeof row.optional !== 'boolean') return fail('execution.variables.optional')
      return { name, ...(row.optional !== undefined ? { optional: row.optional } : {}), purpose: localized(row.purpose, 'execution.variables.purpose') }
    })
    return { kind, skill, runtimeDependency, delegated, variables }
  }
  return fail('item.kind')
}

function readCheck(value: unknown): { readonly command: string; readonly args?: readonly string[] } {
  if (!isRecord(value) || typeof value.command !== 'string' || !namePattern.test(value.command)) return fail('check')
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) || value.args.length > 32 || value.args.some(arg => typeof arg !== 'string' || !argPattern.test(arg)))
  )
    return fail('check.args')
  return { command: value.command, ...(value.args === undefined ? {} : { args: value.args as string[] }) }
}

function readDownload(value: unknown): SuiteCatalogDownload {
  if (!isRecord(value)) return fail('download')
  const source = value.source
  if (source !== 'github-assets' && source !== 'browser' && source !== 'npm' && source !== 'pypi') return fail('download.source')
  if (source === 'npm' || source === 'pypi') {
    const pattern = source === 'npm' ? npmPackagePattern : pypiPackagePattern
    const packages = stringList(value.packages, 'download.packages', item => pattern.test(item.replaceAll('{nodeArch}', 'x64').replaceAll('{arch}', 'amd64')))
    if (packages.length === 0) return fail('download.packages')
    if (value.sha256 !== undefined || value.url !== undefined || value.target !== undefined || value.extract !== undefined || value.executable !== undefined)
      return fail('download: registry packages carry no file fields')
    return { source, packages }
  }
  const url =
    typeof value.url === 'string'
      ? validateDownloadUrl(value.url, source)
      : archValue(value.url, 'download.url', item => validateDownloadUrl(item, source) !== undefined)
  if (url === undefined) return fail('download.url')
  const sha256 = archValue(value.sha256, 'download.sha256', item => hashPattern.test(item))
  for (const architecture of ['amd64', 'arm64'] as const) {
    const configured = typeof url === 'string' ? true : url[architecture] !== undefined
    if (configured && !sha256[architecture]) return fail(`download.sha256: ${architecture} is required`)
  }
  if (typeof value.target !== 'string' || !pathPattern.test(value.target) || value.target.length === 0) return fail('download.target')
  const extract = value.extract === undefined ? undefined : readExtract(value.extract)
  if (value.executable !== undefined && typeof value.executable !== 'boolean') return fail('download.executable')
  if (extract && value.executable) return fail('download: extracted archives cannot be executable files')
  const timeout = value.timeout === undefined ? undefined : readTimeout(value.timeout)
  return {
    source,
    url,
    sha256,
    target: value.target,
    ...(extract ? { extract } : {}),
    ...(value.executable === true ? { executable: true } : {}),
    ...(timeout ? { timeout } : {}),
  }
}

function validateDownloadUrl(value: string, source: 'github-assets' | 'browser'): string | undefined {
  if (value.length > 2048) return undefined
  const substituted = substituteDownloadTokens(value)
  if (substituted === undefined) return undefined
  const pattern = source === 'browser' ? browserPathPattern : downloadUrlPattern
  return pattern.test(substituted) ? value : undefined
}

/** Substitutes only the documented architecture placeholders; any other brace or leftover token is rejected. */
function substituteDownloadTokens(value: string): string | undefined {
  const withoutTokens = value.replace(archTokenPattern, '')
  if (/[{}]/u.test(withoutTokens)) return undefined
  return value.replaceAll('{arch}', 'amd64').replaceAll('{nodeArch}', 'x64')
}

function readTimeout(value: unknown): { readonly connectSeconds?: number; readonly totalSeconds?: number } {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'connectSeconds' && key !== 'totalSeconds')) return fail('download.timeout')
  const read = (item: unknown): number | undefined =>
    item === undefined ? undefined : Number.isInteger(item) && (item as number) > 0 && (item as number) <= 3600 ? (item as number) : fail('download.timeout')
  const connectSeconds = read(value.connectSeconds),
    totalSeconds = read(value.totalSeconds)
  if (connectSeconds === undefined && totalSeconds === undefined) return fail('download.timeout')
  return { ...(connectSeconds === undefined ? {} : { connectSeconds }), ...(totalSeconds === undefined ? {} : { totalSeconds }) }
}

function readExtract(value: unknown): {
  readonly format: 'none' | 'tar' | 'zip'
  readonly directory?: string
  readonly stripComponents?: number
  readonly member?: string
} {
  if (!isRecord(value) || (value.format !== 'none' && value.format !== 'tar' && value.format !== 'zip')) return fail('download.extract')
  const directory = value.directory === undefined ? undefined : safePath(value.directory, 'download.extract.directory')
  const member = value.member === undefined ? undefined : safePath(value.member, 'download.extract.member')
  const strip = value.stripComponents
  if (strip !== undefined && (typeof strip !== 'number' || !Number.isInteger(strip) || strip < 0 || strip > 10)) return fail('download.extract')
  if (value.format === 'none' && (directory !== undefined || member !== undefined || strip !== undefined))
    return fail('download.extract: none takes no options')
  return {
    format: value.format,
    ...(directory ? { directory } : {}),
    ...(typeof strip === 'number' ? { stripComponents: strip } : {}),
    ...(member ? { member } : {}),
  }
}
