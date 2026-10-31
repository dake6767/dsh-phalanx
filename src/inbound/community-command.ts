import { isAbsolute } from 'node:path'
import type { PlatformDatabaseSetupCommand } from '../domain/platform-database.js'
type DatabaseSwitchFields = {
  readonly configFile: string
  readonly dataRoot: string
  readonly target: 'builtin' | 'external'
  readonly connectionFile?: string
  readonly managedOperation?: string
}
type DatabaseSwitchCommand = DatabaseSwitchFields &
  ({ readonly kind: 'database-switch'; readonly maintenanceFile: string } | { readonly kind: 'database-switch-check' })
export type CommunityCommand =
  | {
      readonly kind: 'database-switch-rollback' | 'database-switch-finalize'
      readonly configFile: string
      readonly dataRoot: string
      readonly maintenanceFile: string
      readonly managedOperation: string
    }
  | DatabaseSwitchCommand
  | PlatformDatabaseSetupCommand
  | { readonly kind: 'serve' }
  | { readonly kind: 'managed-operation'; readonly action: 'database-switch'; readonly target: 'builtin' | 'external' }
  | { readonly kind: 'managed-operation'; readonly action: 'master-key-reset'; readonly confirmation: 'RESET ALL PLATFORM SECRETS' }
  | { readonly kind: 'managed-operation'; readonly action: 'master-key-rotate' | 'maintenance-status' | 'maintenance-recover' }
  | { readonly kind: 'help'; readonly text: string }
  | {
      readonly kind: 'master-key-reset'
      readonly configFile: string
      readonly dataRoot: string
      readonly maintenanceFile: string
      readonly recoveryFile: string
      readonly confirmation: string
      readonly managedOperation?: string
    }
  | { readonly kind: 'master-key-fingerprint'; readonly configFile: string; readonly dataRoot: string }
  | {
      readonly kind: 'platform-facts'
      readonly fact: 'download-sources' | 'plugin-budget-rows' | 'schemas'
      readonly configFile: string
      readonly dataRoot: string
    }
  | {
      readonly kind: 'master-key-rotate'
      readonly configFile: string
      readonly dataRoot: string
      readonly maintenanceFile: string
      readonly offline: boolean
      readonly managedOperation?: string
    }
  | { readonly kind: 'bootstrap-link'; readonly dataRoot: string; readonly origin: URL; readonly renew: boolean }
  | { readonly kind: 'migrate-user-storage'; readonly targetRoot: string; readonly mount: string; readonly rollback?: true }

/** Parse operator input before constructing the long-running service. */
export function parseCommunityCommand(args: readonly string[]): CommunityCommand {
  if (args.length === 1 && args[0] === '--help')
    return {
      kind: 'help',
      text: [
        'Usage: dsh-phalanx [COMMAND]',
        'database-switch --target builtin|external',
        '  Managed switching reads database-target.json beside the selected configuration for an external target (0600, service owner). Original database data is retained.',
        'database-switch --config-file PATH --data-root PATH --maintenance-file PATH --target builtin|external [--connection-file PATH] --offline',
        '  Check the target, stop the platform and keep PostgreSQL available; copy and verify all platform rows before selecting it. Original database data is retained.',
        'database-switch-check --config-file PATH --data-root PATH --target builtin|external [--connection-file PATH]',
        'master-key-fingerprint --config-file PATH --data-root PATH',
        '  Authenticate the installed key and print its fingerprint for offline backup verification. No key material is printed.',
        'platform-facts download-sources|plugin-budget-rows|schemas --config-file PATH --data-root PATH',
        '  Print JSON facts for the installer and upgrader without migrating or writing. Exit 2 when the platform database cannot answer.',
        'master-key-rotate',
        '  Submit an independent managed maintenance operation. Use maintenance-status to inspect it or maintenance-recover to resume after a failure.',
        'maintenance-status | maintenance-recover',
        'master-key-reset --confirmation "RESET ALL PLATFORM SECRETS"',
        '  Managed reset reads activePassword and builtinPassword from secret-recovery.json beside the selected database config (service owner, 0600, outside data root).',
        'master-key-reset --config-file PATH --data-root PATH --maintenance-file PATH --recovery-file PATH --confirmation "RESET ALL PLATFORM SECRETS" --offline',
        '  Irreversibly clear platform secrets after losing the master. Preserve accounts; require sign-in and secret reconfiguration. Recovery passwords come from a protected 0600 file.',
        'master-key-rotate --config-file PATH --data-root PATH --maintenance-file PATH --offline',
        '  Stop the platform first and keep PostgreSQL available. Rewrap its data keys in a maintenance window; back up the new master offline.',
      ].join('\n'),
    }
  if (args[0] === 'database-switch-rollback' || args[0] === 'database-switch-finalize') {
    const values = new Map<string, string>(),
      required = ['--config-file', '--data-root', '--maintenance-file', '--managed-operation', '--offline'],
      usage = 'Use the independent maintenance service to recover a managed database switch'
    for (let index = 1; index < args.length; index++) {
      const flag = args[index]!,
        value = flag === '--offline' ? 'true' : args[++index]
      if (!required.includes(flag) || values.has(flag) || !value || (!['--offline', '--managed-operation'].includes(flag) && !isAbsolute(value)))
        throw Error(usage)
      values.set(flag, value)
    }
    if (!required.every(flag => values.has(flag)) || !/^[a-f0-9-]{36}$/u.test(values.get('--managed-operation')!)) throw Error(usage)
    return {
      kind: args[0],
      configFile: values.get('--config-file')!,
      dataRoot: values.get('--data-root')!,
      maintenanceFile: values.get('--maintenance-file')!,
      managedOperation: values.get('--managed-operation')!,
    }
  }
  if (args[0] === 'database-switch' || args[0] === 'database-switch-check') {
    if (args.length === 3 && args[0] === 'database-switch' && args[1] === '--target' && (args[2] === 'builtin' || args[2] === 'external'))
      return { kind: 'managed-operation', action: 'database-switch', target: args[2] }
    const switching = args[0] === 'database-switch',
      values = new Map<string, string>(),
      usage =
        'Usage: database-switch|database-switch-check --config-file PATH --data-root PATH --target builtin|external [--connection-file PATH] [--maintenance-file PATH --offline]'
    const allowed = [
      '--config-file',
      '--data-root',
      '--target',
      '--connection-file',
      ...(switching ? ['--maintenance-file', '--offline', '--managed-operation'] : []),
    ]
    for (let index = 1; index < args.length; index++) {
      const flag = args[index]!,
        value = flag === '--offline' ? 'true' : args[++index]
      if (!allowed.includes(flag) || values.has(flag) || !value || (!['--target', '--offline', '--managed-operation'].includes(flag) && !isAbsolute(value)))
        throw Error(usage)
      values.set(flag, value)
    }
    const target = values.get('--target')
    if (
      !['--config-file', '--data-root', '--target', ...(switching ? ['--maintenance-file', '--offline'] : [])].every(flag => values.has(flag)) ||
      (target !== 'builtin' && target !== 'external') ||
      (target === 'external') !== values.has('--connection-file') ||
      (values.has('--managed-operation') && !/^[a-f0-9-]{36}$/u.test(values.get('--managed-operation')!))
    )
      throw Error(usage)
    const fields: DatabaseSwitchFields = {
      configFile: values.get('--config-file')!,
      dataRoot: values.get('--data-root')!,
      target,
      ...(values.has('--connection-file') ? { connectionFile: values.get('--connection-file')! } : {}),
      ...(values.has('--managed-operation') ? { managedOperation: values.get('--managed-operation')! } : {}),
    }
    return switching ? { kind: 'database-switch', ...fields, maintenanceFile: values.get('--maintenance-file')! } : { kind: 'database-switch-check', ...fields }
  }
  if (args.length === 1 && ['master-key-rotate', 'maintenance-status', 'maintenance-recover'].includes(args[0]!))
    return { kind: 'managed-operation', action: args[0] as 'master-key-rotate' | 'maintenance-status' | 'maintenance-recover' }
  if (args[0] === 'master-key-rotate') {
    const values = new Map<string, string>(),
      usage = 'Usage: master-key-rotate --config-file PATH --data-root PATH --maintenance-file PATH --offline'
    for (let index = 1; index < args.length; index++) {
      const flag = args[index]!,
        value = flag === '--offline' ? 'true' : args[++index]
      if (
        !['--config-file', '--data-root', '--maintenance-file', '--offline', '--managed-operation'].includes(flag) ||
        values.has(flag) ||
        !value ||
        (!['--offline', '--managed-operation'].includes(flag) && !isAbsolute(value))
      )
        throw Error(usage)
      values.set(flag, value)
    }
    if (
      !['--config-file', '--data-root', '--maintenance-file', '--offline'].every(flag => values.has(flag)) ||
      ![4, 5].includes(values.size) ||
      !values.has('--offline') ||
      (values.has('--managed-operation') && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(values.get('--managed-operation')!))
    )
      throw Error(usage)
    return {
      kind: 'master-key-rotate',
      configFile: values.get('--config-file')!,
      dataRoot: values.get('--data-root')!,
      maintenanceFile: values.get('--maintenance-file')!,
      offline: true,
      ...(values.has('--managed-operation') ? { managedOperation: values.get('--managed-operation')! } : {}),
    }
  }
  if (args.length === 3 && args[0] === 'master-key-reset' && args[1] === '--confirmation' && args[2] === 'RESET ALL PLATFORM SECRETS')
    return { kind: 'managed-operation', action: 'master-key-reset', confirmation: 'RESET ALL PLATFORM SECRETS' }
  if (args[0] === 'master-key-reset') {
    const values = new Map<string, string>(),
      usage =
        'Usage: master-key-reset --config-file PATH --data-root PATH --maintenance-file PATH --recovery-file PATH --confirmation "RESET ALL PLATFORM SECRETS" --offline'
    for (let index = 1; index < args.length; index++) {
      const flag = args[index]!,
        value = flag === '--offline' ? 'true' : args[++index]
      if (
        !['--config-file', '--data-root', '--maintenance-file', '--recovery-file', '--confirmation', '--offline', '--managed-operation'].includes(flag) ||
        values.has(flag) ||
        !value ||
        (['--config-file', '--data-root', '--maintenance-file', '--recovery-file'].includes(flag) && !isAbsolute(value))
      )
        throw Error(usage)
      values.set(flag, value)
    }
    if (
      !['--config-file', '--data-root', '--maintenance-file', '--recovery-file', '--confirmation', '--offline'].every(flag => values.has(flag)) ||
      ![6, 7].includes(values.size) ||
      !values.has('--offline') ||
      values.get('--confirmation') !== 'RESET ALL PLATFORM SECRETS' ||
      (values.has('--managed-operation') && !/^[a-f0-9-]{36}$/u.test(values.get('--managed-operation')!))
    )
      throw Error(usage)
    return {
      kind: 'master-key-reset',
      configFile: values.get('--config-file')!,
      dataRoot: values.get('--data-root')!,
      maintenanceFile: values.get('--maintenance-file')!,
      recoveryFile: values.get('--recovery-file')!,
      confirmation: values.get('--confirmation')!,
      ...(values.has('--managed-operation') ? { managedOperation: values.get('--managed-operation')! } : {}),
    }
  }
  if (args[0] === 'master-key-fingerprint') {
    const values = new Map<string, string>(),
      usage = 'Usage: master-key-fingerprint --config-file PATH --data-root PATH'
    for (let index = 1; index < args.length; index++) {
      const flag = args[index]!,
        value = args[++index]
      if (!['--config-file', '--data-root'].includes(flag) || values.has(flag) || !value || !isAbsolute(value)) throw Error(usage)
      values.set(flag, value)
    }
    if (values.size !== 2) throw Error(usage)
    return { kind: 'master-key-fingerprint', configFile: values.get('--config-file')!, dataRoot: values.get('--data-root')! }
  }
  if (args[0] === 'platform-facts') {
    const fact = args[1],
      values = new Map<string, string>(),
      usage = 'Usage: platform-facts download-sources|plugin-budget-rows|schemas --config-file PATH --data-root PATH'
    if (fact !== 'download-sources' && fact !== 'plugin-budget-rows' && fact !== 'schemas') throw Error(usage)
    for (let index = 2; index < args.length; index++) {
      const flag = args[index]!,
        value = args[++index]
      if (!['--config-file', '--data-root'].includes(flag) || values.has(flag) || !value || !isAbsolute(value)) throw Error(usage)
      values.set(flag, value)
    }
    if (values.size !== 2) throw Error(usage)
    return { kind: 'platform-facts', fact, configFile: values.get('--config-file')!, dataRoot: values.get('--data-root')! }
  }
  if (['database-initialize', 'database-password-file', 'database-wait'].includes(args[0] ?? '')) return databaseCommand(args)
  if (args.length === 0) return { kind: 'serve' }
  if (args[0] === 'migrate-user-storage') {
    const values = new Map<string, string>()
    const usage = 'Usage: migrate-user-storage --target-root PATH --mount PATH [--rollback]'
    let rollback = false
    for (let index = 1; index < args.length; index++) {
      const flag = args[index]!
      if (flag === '--rollback') {
        if (rollback) throw new Error(usage)
        rollback = true
        continue
      }
      const value = args[++index]
      if (!['--target-root', '--mount'].includes(flag) || values.has(flag) || value === undefined || value.trim() === '' || value.startsWith('--'))
        throw new Error(usage)
      values.set(flag, value)
    }
    const targetRoot = values.get('--target-root'),
      mount = values.get('--mount')
    if (targetRoot === undefined || mount === undefined) throw new Error(usage)
    return { kind: 'migrate-user-storage', targetRoot, mount, ...(rollback ? { rollback: true as const } : {}) }
  }
  const usage = 'Usage: dsh-phalanx [bootstrap-link --data-root PATH --origin URL [--renew]]'
  if (args[0] !== 'bootstrap-link') throw new Error(usage)
  const values = new Map<string, string>()
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!
    if (!['--data-root', '--origin', '--renew'].includes(flag) || values.has(flag)) throw new Error(usage)
    const value = flag === '--renew' ? 'true' : args[++index]
    if (value === undefined || value.trim() === '' || value.startsWith('--')) throw new Error(usage)
    values.set(flag, value)
  }
  const dataRoot = values.get('--data-root'),
    address = values.get('--origin')
  if (dataRoot === undefined || address === undefined) throw new Error(usage)
  const origin = new URL(address)
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== ''
  )
    throw new Error('Initialization requires an HTTP(S) origin without a path or credentials')
  return { kind: 'bootstrap-link', dataRoot, origin, renew: values.has('--renew') }
}

function databaseCommand(args: readonly string[]): PlatformDatabaseSetupCommand {
  const kind = args[0],
    usage =
      'Usage: database-initialize|database-password-file|database-wait --config-file PATH --data-root PATH [--master-key-file PATH --port PORT | --output PATH]'
  const flags =
    kind === 'database-initialize'
      ? ['--config-file', '--data-root', '--master-key-file', '--port']
      : kind === 'database-password-file'
        ? ['--config-file', '--data-root', '--output']
        : ['--config-file', '--data-root']
  const values = new Map<string, string>()
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!,
      value = args[++index]
    if (!(flags.includes(flag) || (kind !== 'database-initialize' && flag === '--maintenance-file')) || values.has(flag) || !value || value.startsWith('--'))
      throw Error(usage)
    values.set(flag, value)
  }
  if (flags.some(flag => !values.has(flag)) || [...values].some(([flag, value]) => flag !== '--port' && !isAbsolute(value))) throw Error(usage)
  const configFile = values.get('--config-file')!,
    dataRoot = values.get('--data-root')!
  const maintenance = values.has('--maintenance-file') ? { maintenanceFile: values.get('--maintenance-file')! } : {}
  if (kind === 'database-wait') return { kind, configFile, dataRoot, ...maintenance }
  if (kind === 'database-password-file') return { kind, configFile, dataRoot, output: values.get('--output')!, ...maintenance }
  const port = Number(values.get('--port'))
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error(usage)
  return { kind: 'database-initialize', configFile, dataRoot, masterKeyPath: values.get('--master-key-file')!, port }
}
