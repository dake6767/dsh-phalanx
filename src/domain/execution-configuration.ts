import { executionCommandPath, executionLongOption } from './execution-command-line.js'
import { BusinessRuleError } from './business-error.js'
import type { CommunityExecutionInput } from './admin-contract.js'
import type { ExecutionConfiguration } from './platform-execution.js'

const invalid = () => new BusinessRuleError('invalid', 'Check the execution commands and variables.', 'execution-config-invalid')
const reserved = (name: string) => /^(DSH_|LD_|DYLD_|NODE_|PYTHON)/iu.test(name)
  || /^(HOME|PATH|SHELL|TMPDIR|TMP|TEMP|BASH_ENV|ENV|IFS|CDPATH|GLOBIGNORE|SHELLOPTS|BASHOPTS)$/iu.test(name)
export function executionConfiguration(input: CommunityExecutionInput, previous?: ExecutionConfiguration): ExecutionConfiguration {
  if (!input || typeof input !== 'object' || typeof input.enabled !== 'boolean' || !Array.isArray(input.commands) || !Array.isArray(input.variables)
    || (input.runtimeDependencies !== undefined && (!Array.isArray(input.runtimeDependencies) || input.runtimeDependencies.some(name => typeof name !== 'string' || !name) || new Set(input.runtimeDependencies).size !== input.runtimeDependencies.length))
    || input.commands.length > 32 || input.variables.length > 64 || (input.enabled && !input.commands.length)
    || (input.prepare !== undefined && (typeof input.prepare !== 'string' || input.prepare.length > 8192))) throw invalid()
  const commands = input.commands.map((row: CommunityExecutionInput['commands'][number]) => {
    if (!row || !executionCommandPath(row.command) || (row.source !== undefined && (!executionCommandPath(row.source) || !row.source.includes('/')))
      || (row.memberPath !== undefined && (!row.source || !executionCommandPath(row.memberPath) || !row.memberPath.includes('/')))
      || (row.blockedOptions !== undefined && (!Array.isArray(row.blockedOptions) || row.blockedOptions.length > 100 || row.blockedOptions.some(value => !executionLongOption(value))))
      || !Array.isArray(row.blocked) || row.blocked.length > 100 || row.blocked.some((value: unknown) => typeof value !== 'string' || value.length > 256 || value.includes('\0'))) throw invalid()
    return { command: row.command, ...(row.source ? { source: row.source } : {}), ...(row.memberPath ? { memberPath: row.memberPath } : {}), ...(row.blockedOptions?.length ? { blockedOptions: [...new Set(row.blockedOptions)] } : {}), blocked: [...new Set(row.blocked)] }
  })
  const variables = input.variables.map((row: CommunityExecutionInput['variables'][number]) => {
    if (!row || typeof row.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(row.name) || reserved(row.name) || typeof row.secret !== 'boolean'
      || (row.value !== undefined && (typeof row.value !== 'string' || row.value.length > 65536 || row.value.includes('\0')))) throw invalid()
    const old = previous?.variables.find(value => value.name === row.name)
    // A saved secret cannot be made readable simply by changing its classification.
    if (old?.secret && !row.secret && row.value === undefined) throw invalid()
    return { name: row.name, secret: row.secret, value: row.value ?? old?.value ?? '' }
  })
  const optionalVariables = input.optionalVariables ?? previous?.optionalVariables?.filter(name => variables.some(row => row.name === name))
  if (optionalVariables !== undefined && (!Array.isArray(optionalVariables) || optionalVariables.some(name => typeof name !== 'string' || !variables.some(row => row.name === name)) || new Set(optionalVariables).size !== optionalVariables.length)) throw invalid()
  if (new Set(commands.map(row => row.command)).size !== commands.length || new Set(variables.map(row => row.name)).size !== variables.length) throw invalid()
  return { ...(optionalVariables?.length ? { optionalVariables: [...optionalVariables] } : {}), ...(previous?.suiteOrigin ? { suiteOrigin: previous.suiteOrigin } : {}), ...(previous?.contributionReceipt ? { contributionReceipt: previous.contributionReceipt } : {}), ...(previous?.awaitingPreparation ? { awaitingPreparation: true } : {}), ...(previous?.approvedContribution ? { approvedContribution: previous.approvedContribution } : {}), enabled: input.enabled, commands, variables, ...(input.runtimeDependencies ? { runtimeDependencies: [...input.runtimeDependencies] } : {}), ...(input.prepare ? { prepare: input.prepare } : {}) }
}
