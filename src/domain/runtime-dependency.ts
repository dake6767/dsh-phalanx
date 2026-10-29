import type { CommunityRuntimeDependencyInput } from './admin-contract.js'
import { BusinessRuleError } from './business-error.js'
import { pythonLibraryPreparation, pythonPackagePins } from './python-library.js'
import type {
  CommunityCommandRuntimeDependencyInput,
  CommunityPythonLibraryDependencyInput,
  CommunityResourceRuntimeDependencyInput,
} from './runtime-dependency-contract.js'

export type RuntimeDependencySource = 'manual' | 'mcp-catalog' | 'suite-catalog'
export type RuntimeDependencyFailureCode = 'prepare-failed' | 'path-invalid' | 'link-escape' | 'command-conflict' | 'check-failed' | 'interrupted'
export interface RuntimeDependencyCheck {
  readonly kind: 'paths' | 'links' | 'commands' | 'check-command'
  readonly passed: boolean
  readonly detail?: string
}
export interface RuntimeDependencyReference {
  readonly kind: 'skill' | 'execution' | 'mcp' | 'plugin'
  readonly name: string
}
export interface RuntimeDependencyVersion {
  readonly id: string
  readonly identity: string
  readonly directory: string
  readonly mountedPath: string
  readonly pathDirectories: readonly string[]
  readonly commands: readonly string[]
  readonly commandPaths: Readonly<Record<string, string>>
  readonly bytes: number
  readonly isolated: boolean
  readonly checks: readonly RuntimeDependencyCheck[]
  readonly log: string
  readonly python?: { readonly name: string; readonly interpreter: string; readonly sitePackages: string; readonly abi: string }
}
export type RuntimeDependencyDefinition =
  | CommunityCommandRuntimeDependencyInput
  | (CommunityResourceRuntimeDependencyInput & { readonly pathDirectories: readonly string[] })
  | (CommunityPythonLibraryDependencyInput & { readonly prepareCommand: string; readonly pathDirectories: readonly string[]; readonly checkCommand?: string })

export type RuntimeDependency = RuntimeDependencyDefinition & {
  readonly rowRevision?: number
  readonly managedItem?: string
  readonly managedOrigin?: string
  readonly replaces?: string
  readonly candidate?: boolean
  readonly source: RuntimeDependencySource
  readonly stage: 'preparing' | 'validating' | 'ready' | 'failed'
  readonly retryPending?: boolean
  readonly preparationIdentity?: string
  readonly updatedAt: number
  readonly log: string
  readonly checks: readonly RuntimeDependencyCheck[]
  readonly failureCode?: RuntimeDependencyFailureCode
  readonly current?: RuntimeDependencyVersion
  readonly previous?: RuntimeDependencyVersion
}
/** Manual rows no other owner manages; manual MCP services register theirs with an origin and are never taken over. */
export function unownedManualDependency(row: RuntimeDependency): boolean {
  return row.source === 'manual' && row.managedOrigin === undefined
}
export class RuntimeDependencyPreparationFailure extends Error {
  constructor(
    readonly code: RuntimeDependencyFailureCode,
    readonly log: string,
    readonly checks: readonly RuntimeDependencyCheck[] = [],
  ) {
    super('Runtime dependency preparation failed')
  }
}

/** Runtime dependencies have no credential or environment-variable declaration. */
export function runtimeDependencyInput(value: CommunityRuntimeDependencyInput): RuntimeDependencyDefinition {
  const fail = () => {
    throw new BusinessRuleError(
      'invalid',
      'Check the runtime dependency definition. Environment and credential variables are not accepted.',
      'runtime-dependency-invalid',
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  if (typeof value.name !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,99}$/u.test(value.name)) return fail()
  if (value.type === 'python-library') {
    if (Object.keys(value).some(key => !['name', 'type', 'packages', 'prepareCommand', 'pathDirectories', 'checkCommand'].includes(key))) return fail()
    const packages = pythonPackagePins(value.packages)
    if (!packages) return fail()
    return {
      name: value.name,
      type: 'python-library',
      packages,
      prepareCommand: pythonLibraryPreparation(packages),
      pathDirectories: ['venv/bin'],
      checkCommand: '"$RD_OUT/venv/bin/python3" -m pip check',
    }
  }
  if (
    (value.type !== undefined && value.type !== 'commands' && value.type !== 'resource') ||
    Object.keys(value).some(key => !['name', 'type', 'prepareCommand', 'pathDirectories', 'checkCommand'].includes(key))
  )
    return fail()
  const pathDirectories = value.pathDirectories ?? (value.type === 'resource' ? [] : undefined)
  if (
    typeof value.name !== 'string' ||
    !/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,99}$/u.test(value.name) ||
    typeof value.prepareCommand !== 'string' ||
    !value.prepareCommand.trim() ||
    value.prepareCommand.length > 128 * 1024 ||
    !Array.isArray(pathDirectories) ||
    (value.type !== 'resource' && pathDirectories.length === 0) ||
    pathDirectories.some(
      path =>
        typeof path !== 'string' ||
        !path ||
        path.startsWith('/') ||
        /[\\:]/u.test(path) ||
        [...path].some(character => character.charCodeAt(0) < 32) ||
        path.split('/').some(part => part === '..' || part === ''),
    ) ||
    new Set(pathDirectories).size !== pathDirectories.length ||
    (value.checkCommand !== undefined && (typeof value.checkCommand !== 'string' || value.checkCommand.length > 128 * 1024))
  )
    return fail()
  return {
    name: value.name,
    ...(value.type === 'resource' ? { type: value.type } : {}),
    prepareCommand: value.prepareCommand,
    pathDirectories: [...pathDirectories!],
    ...(value.checkCommand ? { checkCommand: value.checkCommand } : {}),
  }
}

export function assertPublicRuntimeDependency(row: RuntimeDependency): void {
  if (row.candidate) throw new BusinessRuleError('conflict', 'MCP update candidates are internal.', 'runtime-dependency-unavailable')
}

export function assertRuntimeDependencyRow(row: RuntimeDependency): void {
  if (!row || typeof row !== 'object') throw new Error('Invalid runtime dependency record')
  runtimeDependencyInput(
    row.type === 'python-library'
      ? { name: row.name, type: row.type, packages: row.packages }
      : {
          name: row.name,
          ...(row.type ? { type: row.type } : {}),
          prepareCommand: row.prepareCommand,
          pathDirectories: row.pathDirectories,
          ...(row.checkCommand !== undefined ? { checkCommand: row.checkCommand } : {}),
        },
  )
  if (
    (row.managedItem !== undefined && typeof row.managedItem !== 'string') ||
    (row.retryPending !== undefined && typeof row.retryPending !== 'boolean') ||
    (row.candidate !== undefined && typeof row.candidate !== 'boolean') ||
    (row.managedOrigin !== undefined && typeof row.managedOrigin !== 'string') ||
    (row.replaces !== undefined && typeof row.replaces !== 'string') ||
    (row.preparationIdentity !== undefined && typeof row.preparationIdentity !== 'string') ||
    !['manual', 'mcp-catalog', 'suite-catalog'].includes(row.source) ||
    !['preparing', 'validating', 'ready', 'failed'].includes(row.stage) ||
    !Number.isFinite(row.updatedAt) ||
    typeof row.log !== 'string' ||
    !Array.isArray(row.checks) ||
    (row.stage === 'ready' && !row.current)
  )
    throw new Error('Invalid runtime dependency record')
  for (const version of [row.current, row.previous])
    if (
      version &&
      (!/^[a-f0-9]{64}$/u.test(version.id) ||
        typeof version.identity !== 'string' ||
        typeof version.directory !== 'string' ||
        typeof version.mountedPath !== 'string' ||
        !Array.isArray(version.pathDirectories) ||
        !Array.isArray(version.commands) ||
        !version.commandPaths ||
        typeof version.commandPaths !== 'object' ||
        !version.commands.every(command => typeof command === 'string' && typeof version.commandPaths[command] === 'string') ||
        !Number.isFinite(version.bytes) ||
        typeof version.isolated !== 'boolean' ||
        !Array.isArray(version.checks) ||
        typeof version.log !== 'string' ||
        (version.python !== undefined &&
          (!version.python ||
            typeof version.python.name !== 'string' ||
            version.python.interpreter !== 'venv/bin/python3' ||
            !/^venv\/lib\/python3\.\d+\/site-packages$/u.test(version.python.sitePackages) ||
            !/^cpython-\d+$/u.test(version.python.abi))))
    )
      throw new Error('Invalid runtime dependency version')
}
