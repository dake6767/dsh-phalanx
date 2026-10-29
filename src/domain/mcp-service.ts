import { MAX_EXECUTION_TIMEOUT_SECONDS } from './execution-control.js'
import type { CommunityMcpService, CommunityMcpInput, CommunityMcpTemplate, CommunityMcpTool, CommunityMcpSettings } from './admin-contract.js'
import { HOP_HEADERS } from './plugin-upstream.js'
import { BusinessRuleError } from './business-error.js'
import { mcpSecrets, redactMcpValue } from './mcp-protocol.js'
import { mcpPlatformCredentials, referencedMcpSecrets, retainedMcpSecrets } from './mcp-protected-values.js'

export interface McpService extends CommunityMcpService {
  /** Internal optimistic row token; management settings omit it. */
  readonly rowRevision?: string
  /** A lost-key reset keeps the draft while preventing preparation or projection. */
  readonly configurationRequired?: true
  /** Internal encrypted literals still referenced after their credential slot changes. */
  readonly protectedValues?: readonly string[]
  /** Retained named platform credentials keep their boundary classification. */
  readonly protectedCredentials?: readonly string[]
  readonly catalog?: import('./admin-contract.js').CommunityMcpCatalogSource
  readonly catalogRequestId?: string
  readonly preparationName?: string
  readonly catalogUpdate?: {
    readonly name: string
    readonly requestId: string
    readonly version: string
    readonly testedPreparation?: string
    readonly baseGeneration: number
    readonly actor: import('./community-account.js').CommunityAccountActor
    readonly status: 'preparing' | 'testing' | 'failed' | 'applied'
    readonly candidate?: McpService | undefined
  }
  readonly dependencyName?: string
  readonly dependencyTarget?: string
  readonly dependencyPromotion?: { readonly from: string; readonly to: string }
  readonly prepared?: {
    readonly directory: string
    readonly dependencies?: readonly import('./runtime-dependency.js').RuntimeDependencyVersion[]
  }
  readonly published?: boolean
  readonly required?: boolean
  readonly generation: number
  readonly credentials?: Readonly<Record<string, string>>
  readonly credential?: string
  readonly headers?: readonly CommunityMcpTemplate[]
  readonly query?: readonly CommunityMcpTemplate[]
  readonly disabledTools?: readonly string[]
  readonly tools?: readonly CommunityMcpTool[]
  readonly testStatus?: 'untested' | 'passed' | 'failed'
}
const secretStatus = (value = '') => ({ configured: Boolean(value), last4: value.slice(-4) })
export function mcpProtectedFields(service: McpService): Readonly<Record<string, { configured: boolean; last4: string }>> {
  const known = mcpSecrets(service),
    fields: Record<string, { configured: boolean; last4: string }> = {}
  const protect = (name: string, value: string) => {
    if (value && redactMcpValue(value, known) !== value) fields[name] = secretStatus(value)
  }
  protect('url', service.url)
  try {
    if (new URL(service.url).search) fields.url = secretStatus(service.url)
  } catch {
    /* Process services can have no URL. */
  }
  if (service.run) {
    protect('command', service.run.command)
    service.run.args.forEach((value, index) => protect('args/' + index, value))
    if (service.run.prepareCommand) protect('prepareCommand', service.run.prepareCommand)
  }
  return fields
}
export function mcpSettings(service: McpService): CommunityMcpSettings {
  const protectedFields = mcpProtectedFields(service),
    known = mcpSecrets(service)
  const text = (name: string, value: string) => (protectedFields[name] ? '' : value)
  return {
    ...(service.catalogUpdate ? { catalogUpdate: { version: service.catalogUpdate.version, status: service.catalogUpdate.status } } : {}),
    ...(service.catalog ? { catalog: service.catalog } : {}),
    generation: service.generation,
    protectedFields,
    credential: secretStatus(service.credential),
    credentials: Object.fromEntries(Object.entries(service.credentials ?? {}).map(([name, value]) => [name, secretStatus(value)])),
    run: service.run
      ? {
          ...service.run,
          command: text('command', service.run.command),
          args: service.run.args.map((value, index) => text('args/' + index, value)),
          ...(service.run.prepareCommand !== undefined ? { prepareCommand: text('prepareCommand', service.run.prepareCommand) } : {}),
          env: service.run.env.map(row => ({ name: row.name, ...secretStatus(row.value) })),
        }
      : null,
    credentialNames: Object.keys(service.credentials ?? {}).filter(name => Boolean(service.credentials?.[name])),
    published: service.published ?? false,
    required: service.required ?? false,
    name: service.name,
    description: String(redactMcpValue(service.description, known)),
    url: text('url', service.url),
    credentialConfigured: Boolean(service.credential),
    headers: (service.headers ?? []).map(row => ({ name: row.name, ...secretStatus(row.value) })),
    query: (service.query ?? []).map(row => ({ name: row.name, ...secretStatus(row.value) })),
    disabledTools: service.disabledTools ?? [],
    tools: redactMcpValue(service.tools ?? [], known) as readonly CommunityMcpTool[],
    testStatus: service.testStatus ?? 'untested',
  }
}
/** Converts read-only summaries to an edit draft without ever copying a saved secret. */
export function mcpWriteInput(view: CommunityMcpSettings): CommunityMcpInput {
  const blank = (rows: readonly { name: string }[]) => rows.map(row => ({ name: row.name, value: '' }))
  return {
    name: view.name,
    description: view.description,
    url: view.url,
    required: view.required,
    disabledTools: view.disabledTools,
    headers: blank(view.headers),
    query: blank(view.query),
    run: view.run ? { ...view.run, env: blank(view.run.env) } : null,
    retainedArguments:
      view.run?.args.flatMap((_value, index) => (view.protectedFields['args/' + index] ? [{ index, sourceIndex: index, generation: view.generation }] : [])) ??
      [],
  }
}
/** Resolves only explicit retain references and blank values belonging to the current service. */
export function mergeMcpInput(
  input: CommunityMcpInput,
  previous?: McpService,
): CommunityMcpInput & Pick<McpService, 'protectedValues' | 'protectedCredentials'> {
  const invalid = () => new BusinessRuleError('invalid', 'Invalid MCP secret update.', 'mcp-service-invalid')
  if (!input || typeof input !== 'object') throw invalid()
  if (input.clearCredential !== undefined && typeof input.clearCredential !== 'boolean') throw invalid()
  if (input.removeCredentials !== undefined && (!Array.isArray(input.removeCredentials) || input.removeCredentials.some(name => typeof name !== 'string')))
    throw invalid()
  if (input.clearCredential && input.credential) throw invalid()
  const fields = previous ? mcpProtectedFields(previous) : {}
  const rows = (next: readonly CommunityMcpTemplate[] | undefined, old: readonly CommunityMcpTemplate[] = [], headers = false) => {
    if (next === undefined) return old
    if (!Array.isArray(next)) return next
    return next.map(row => {
      if (!row || typeof row.name !== 'string' || typeof row.value !== 'string') throw invalid()
      return row.value === ''
        ? { ...row, value: old.find(saved => (headers ? saved.name.toLowerCase() === row.name.toLowerCase() : saved.name === row.name))?.value ?? '' }
        : row
    })
  }
  const credentials = { ...previous?.credentials }
  if (input.credentials !== undefined && (!input.credentials || typeof input.credentials !== 'object' || Array.isArray(input.credentials))) throw invalid()
  for (const [name, value] of Object.entries(input.credentials ?? {})) {
    if (value !== '') credentials[name] = value
  }
  for (const name of input.removeCredentials ?? []) {
    if (input.credentials?.[name]) throw invalid()
    delete credentials[name]
  }
  let run = input.run === undefined ? (previous?.run ?? null) : input.run
  if (run) {
    let args = run.args
    if (input.retainedArguments !== undefined) {
      if (!Array.isArray(input.retainedArguments) || !Array.isArray(args)) throw invalid()
      args = [...args]
      const seen = new Set<number>(),
        sources = new Set<number>()
      for (const ref of input.retainedArguments) {
        if (
          !ref ||
          !previous?.run ||
          ref.generation !== previous.generation ||
          !Number.isInteger(ref.index) ||
          ref.index < 0 ||
          ref.index >= args.length ||
          !Number.isInteger(ref.sourceIndex) ||
          !fields['args/' + ref.sourceIndex] ||
          seen.has(ref.index) ||
          sources.has(ref.sourceIndex) ||
          args[ref.index] !== ''
        )
          throw invalid()
        seen.add(ref.index)
        sources.add(ref.sourceIndex)
        ;(args as string[])[ref.index] = previous.run.args[ref.sourceIndex]!
      }
    }
    run = {
      ...run,
      command: (run.command === '' || run.command === undefined) && fields.command ? previous!.run!.command : run.command,
      args,
      ...(run.prepareCommand === '' && fields.prepareCommand ? { prepareCommand: previous!.run!.prepareCommand } : {}),
      env: rows(run.env, previous?.run?.env),
    }
  } else if (input.retainedArguments?.length) throw invalid()
  const supplied = { ...input } as CommunityMcpInput & { protectedValues?: readonly string[]; protectedCredentials?: readonly string[] }
  delete supplied.protectedValues
  delete supplied.protectedCredentials
  const merged = {
    ...supplied,
    url: (input.url === '' || input.url === undefined) && fields.url ? previous!.url : input.url,
    run,
    credentials,
    credential: input.clearCredential ? '' : input.credential === '' || input.credential === undefined ? (previous?.credential ?? '') : input.credential,
    headers: rows(input.headers, previous?.headers, true),
    query: rows(input.query, previous?.query),
  }
  const known = previous ? mcpSecrets(previous) : []
  const platformCredentials = previous ? mcpPlatformCredentials(previous) : []
  if (merged.run?.location === 'member' && previous?.run?.location !== 'member' && referencedMcpSecrets({ run: merged.run }, platformCredentials).length)
    throw invalid()
  const protectedValues = retainedMcpSecrets(merged, known)
  const currentCredentials = new Set(mcpPlatformCredentials({ credential: merged.credential, credentials: merged.credentials }))
  const protectedCredentials = referencedMcpSecrets(merged, platformCredentials).filter(value => !currentCredentials.has(value))
  const result = { ...merged, ...(protectedValues.length ? { protectedValues } : {}), ...(protectedCredentials.length ? { protectedCredentials } : {}) }
  validateMcpSettings(result)
  return result
}
export interface McpState {
  readonly catalogRequests?: readonly string[]
  readonly revision?: number
  readonly preferences?: Readonly<Record<string, Readonly<Record<string, boolean>>>>
  readonly selections?: Readonly<Record<string, readonly string[]>>
  readonly services: readonly McpService[]
  readonly grants: Readonly<Record<string, readonly string[]>>
}
export function validateMcpService(value: CommunityMcpService): void {
  const invalid = () =>
    new BusinessRuleError('invalid', 'Use a p- prefixed name of 3–32 letters, digits, underscores or hyphens and an HTTP address.', 'mcp-service-invalid')
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.name !== 'string' ||
    !/^p-[A-Za-z0-9_-]{1,30}$/u.test(value.name) ||
    typeof value.description !== 'string' ||
    value.description.length > 4000 ||
    typeof value.url !== 'string'
  )
    throw invalid()
  if (value.run != null) {
    const run = value.run
    if (
      !['shared', 'member'].includes(run.location) ||
      typeof run.command !== 'string' ||
      !run.command.trim() ||
      run.command.length > 4096 ||
      /[\r\n\0]/u.test(run.command) ||
      !Array.isArray(run.args) ||
      run.args.length > 128 ||
      run.args.some(arg => typeof arg !== 'string' || arg.length > 16384 || arg.includes('\0')) ||
      !Array.isArray(run.env) ||
      (run.prepareCommand !== undefined && (typeof run.prepareCommand !== 'string' || run.prepareCommand.length > 32768)) ||
      (run.runtimeDependencies !== undefined &&
        (!Array.isArray(run.runtimeDependencies) ||
          run.runtimeDependencies.some(name => typeof name !== 'string' || !name) ||
          new Set(run.runtimeDependencies).size !== run.runtimeDependencies.length))
    )
      throw invalid()
    return
  }
  let url: URL
  try {
    url = new URL(value.url)
  } catch {
    throw invalid()
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw invalid()
}

export function validateMcpSettings(value: CommunityMcpInput & Pick<McpService, 'protectedValues' | 'protectedCredentials'>): void {
  validateMcpService(value)
  const invalid = () => new BusinessRuleError('invalid', 'Invalid MCP credential, templates or disabled tools.', 'mcp-service-invalid')
  if (
    value.credentials !== undefined &&
    (!value.credentials ||
      typeof value.credentials !== 'object' ||
      Array.isArray(value.credentials) ||
      Object.entries(value.credentials).length > 32 ||
      Object.entries(value.credentials).some(
        ([name, secret]) => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name) || typeof secret !== 'string' || secret.length > 16384 || /[^\x20-\x7e]/u.test(secret),
      ))
  )
    throw invalid()
  if (value.required !== undefined && typeof value.required !== 'boolean') throw invalid()
  if (value.credential !== undefined && (typeof value.credential !== 'string' || value.credential.length > 16384 || /[^\x20-\x7e]/u.test(value.credential)))
    throw invalid()
  for (const [kind, rows] of [
    ['headers', value.headers],
    ['query', value.query],
    ['env', value.run?.env],
  ] as const) {
    if (rows === undefined) continue
    if (!Array.isArray(rows) || rows.length > 32) throw invalid()
    const seen = new Set<string>()
    for (const row of rows) {
      if (
        !row ||
        typeof row.name !== 'string' ||
        typeof row.value !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/u.test(row.name) ||
        row.value.length > 16384 ||
        /[^\x20-\x7e]/u.test(row.value)
      )
        throw invalid()
      const name = kind === 'headers' ? row.name.toLowerCase() : row.name
      if (
        seen.has(name) ||
        (kind === 'headers' &&
          (HOP_HEADERS.has(name) ||
            name.startsWith('proxy-') ||
            [
              'host',
              'content-length',
              'content-type',
              'accept',
              'accept-encoding',
              'expect',
              'cookie',
              'set-cookie',
              'mcp-session-id',
              'mcp-protocol-version',
            ].includes(name)))
      )
        throw invalid()
      seen.add(name)
    }
  }
  if (
    value.run?.location === 'member' &&
    (value.credential || Object.values(value.credentials ?? {}).some(Boolean) || value.run.env.some(row => /\{credential(?::[^}]+)?\}/u.test(row.value)))
  )
    throw invalid()
  if (
    value.disabledTools !== undefined &&
    (!Array.isArray(value.disabledTools) ||
      value.disabledTools.length > 10000 ||
      value.disabledTools.some(name => typeof name !== 'string' || !name || name.length > 256))
  )
    throw invalid()
  if (value.run?.prepareCommand && redactMcpValue(value.run.prepareCommand, mcpSecrets(value)) !== value.run.prepareCommand) {
    throw new BusinessRuleError('invalid', 'Preparation commands cannot contain runtime credentials.', 'mcp-service-invalid')
  }
}

// Shared execution owns per-call deadlines; outer clients leave room for recovery.
export const SHARED_MCP_REQUEST_CEILING_MS = MAX_EXECUTION_TIMEOUT_SECONDS * 1000 + 30_000
